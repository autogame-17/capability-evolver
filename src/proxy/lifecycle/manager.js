'use strict';

const { PROXY_PROTOCOL_VERSION } = require('../mailbox/store');
const crypto = require('crypto');

const DEFAULT_HEARTBEAT_INTERVAL = 360_000;
const HELLO_TIMEOUT = 15_000;
const HEARTBEAT_TIMEOUT = 10_000;
const MAX_REAUTH_ATTEMPTS = 2;

let _cachedFingerprint = null;
function _getEnvFingerprint() {
  if (_cachedFingerprint) return _cachedFingerprint;
  try {
    const { captureEnvFingerprint } = require('../../gep/envFingerprint');
    _cachedFingerprint = captureEnvFingerprint();
  } catch {
    _cachedFingerprint = {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
    };
  }
  return _cachedFingerprint;
}

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

class LifecycleManager {
  constructor({ hubUrl, store, logger, getTaskMeta } = {}) {
    this.hubUrl = (hubUrl || process.env.A2A_HUB_URL || '').replace(/\/+$/, '');
    this.store = store;
    this.logger = logger || console;
    this.getTaskMeta = getTaskMeta || null;
    this._heartbeatTimer = null;
    this._running = false;
    this._startedAt = null;
    this._consecutiveFailures = 0;
    this._reauthInProgress = false;
  }

  get nodeId() {
    return this.store.getState('node_id');
  }

  get nodeSecret() {
    return this.store.getState('node_secret') || process.env.A2A_NODE_SECRET || null;
  }

  _buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const secret = this.nodeSecret;
    if (secret) headers['Authorization'] = 'Bearer ' + secret;
    headers['x-correlation-id'] = crypto.randomUUID();
    return headers;
  }

  async hello({ rotateSecret = false } = {}) {
    if (!this.hubUrl) return { ok: false, error: 'no_hub_url' };

    if (this._helloRateLimitUntil > Date.now()) {
      const waitSec = Math.ceil((this._helloRateLimitUntil - Date.now()) / 1000);
      this.logger.warn(`[lifecycle] hello suppressed: rate limited for ${waitSec}s`);
      return { ok: false, error: 'hello_rate_limit_active', waitSec };
    }

    const endpoint = `${this.hubUrl}/a2a/hello`;
    const nodeId = this.store.getState('node_id') || `node_${crypto.randomBytes(6).toString('hex')}`;

    const payload = { capabilities: {} };
    if (rotateSecret) payload.rotate_secret = true;

    const fp = _getEnvFingerprint();

    const body = {
      protocol: 'gep-a2a',
      protocol_version: '1.0.0',
      message_type: 'hello',
      message_id: 'msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
      sender_id: nodeId,
      timestamp: new Date().toISOString(),
      payload,
      env_fingerprint: fp,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HELLO_TIMEOUT),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData?.error || `http_${res.status}`;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '3600', 10);
          this._helloRateLimitUntil = Date.now() + retryAfter * 1000;
          this.logger.error(`[lifecycle] hello rate limited (429): retry after ${retryAfter}s`);
          return { ok: false, error: 'hello_rate_limited', retryAfter };
        }
        this.logger.error(`[lifecycle] hello HTTP ${res.status}: ${errMsg}`);
        return { ok: false, error: errMsg, statusCode: res.status };
      }

      const data = await res.json();

      if (data?.payload?.status === 'rejected') {
        this.logger.error(`[lifecycle] hello rejected: ${data.payload.reason || 'unknown'}`);
        return { ok: false, error: data.payload.reason || 'hello_rejected', response: data };
      }

      const secret = data?.payload?.node_secret || data?.node_secret || null;
      if (secret && /^[a-f0-9]{64}$/i.test(secret)) {
        this.store.setState('node_secret', secret);
        this.logger.log('[lifecycle] new node_secret stored from hello response');
      }

      this.store.setState('node_id', nodeId);
      this.logger.log(`[lifecycle] hello OK, node_id=${nodeId}${rotateSecret ? ' (secret rotated)' : ''}`);
      return { ok: true, nodeId, response: data };
    } catch (err) {
      this.logger.error(`[lifecycle] hello failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Re-authenticate after 403: rotate secret via hello, then verify with a
   * heartbeat. Returns true if auth is restored, false otherwise.
   */
  async reAuthenticate() {
    if (this._reauthInProgress) return false;
    if (this._reauthBackoffUntil > Date.now()) {
      const waitSec = Math.ceil((this._reauthBackoffUntil - Date.now()) / 1000);
      this.logger.warn(`[lifecycle] re-auth suppressed: backoff active for ${waitSec}s`);
      return false;
    }
    this._reauthInProgress = true;
    try {
      for (let attempt = 1; attempt <= MAX_REAUTH_ATTEMPTS; attempt++) {
        this.logger.warn(`[lifecycle] re-auth attempt ${attempt}/${MAX_REAUTH_ATTEMPTS}: rotating secret via hello...`);
        const helloResult = await this.hello({ rotateSecret: true });
        if (!helloResult.ok) {
          this.logger.error(`[lifecycle] re-auth hello failed: ${helloResult.error}`);
          if (helloResult.error === 'hello_rate_limited' || helloResult.error === 'hello_rate_limit_active') break;
          continue;
        }
        const newSecret = helloResult.response?.payload?.node_secret;
        if (!newSecret) {
          this.logger.error('[lifecycle] re-auth: hub did not return a new secret (rotate may not have taken effect)');
          break;
        }
        const hbResult = await this.heartbeat({ _skipReauth: true });
        if (hbResult.ok) {
          this.logger.log('[lifecycle] re-auth succeeded: heartbeat confirmed with new secret');
          return true;
        }
        this.logger.warn(`[lifecycle] re-auth attempt ${attempt}: heartbeat still failing after rotate`);
      }
      this.logger.error('[lifecycle] re-auth exhausted all attempts, backing off for 30 minutes');
      this._reauthBackoffUntil = Date.now() + 30 * 60_000;
      return false;
    } finally {
      this._reauthInProgress = false;
    }
  }

  async heartbeat({ _skipReauth = false } = {}) {
    if (!this.hubUrl) return { ok: false, error: 'no_hub_url' };

    const nodeId = this.nodeId;
    if (!nodeId) {
      const helloResult = await this.hello();
      if (!helloResult.ok) return helloResult;
    }

    const endpoint = `${this.hubUrl}/a2a/heartbeat`;
    const taskMeta = typeof this.getTaskMeta === 'function' ? this.getTaskMeta() : {};
    const fp = _getEnvFingerprint();
    const body = {
      node_id: this.nodeId,
      sender_id: this.nodeId,
      evolver_version: fp.evolver_version || PROXY_PROTOCOL_VERSION,
      env_fingerprint: fp,
      meta: {
        proxy_version: PROXY_PROTOCOL_VERSION,
        proxy_protocol_version: PROXY_PROTOCOL_VERSION,
        outbound_pending: this.store.countPending({ direction: 'outbound' }),
        inbound_pending: this.store.countPending({ direction: 'inbound' }),
        ...taskMeta,
      },
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT),
      });

      if (res.status === 403 || res.status === 401) {
        this._consecutiveFailures++;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat auth failed (${res.status}): ${errText}`);
        if (!_skipReauth) {
          const recovered = await this.reAuthenticate();
          if (recovered) {
            this._consecutiveFailures = 0;
            return { ok: true, recovered: true };
          }
        }
        return { ok: false, error: `auth_failed_${res.status}`, statusCode: res.status };
      }

      if (!res.ok) {
        this._consecutiveFailures++;
        const errText = await res.text().catch(() => '');
        this.logger.error(`[lifecycle] heartbeat HTTP ${res.status}: ${errText}`);
        return { ok: false, error: `http_${res.status}`, statusCode: res.status };
      }

      const data = await res.json();

      this._consecutiveFailures = 0;
      this.store.setState('last_heartbeat_at', new Date().toISOString());

      if (data?.status === 'unknown_node') {
        this.logger.warn('[lifecycle] Node unknown, re-registering...');
        await this.hello();
      }

      if (Array.isArray(data?.events) && data.events.length > 0) {
        this.store.writeInboundBatch(
          data.events.map(e => ({
            type: e.type || 'hub_event',
            payload: e,
            channel: 'evomap-hub',
          }))
        );
      }

      if (data?.min_proxy_version && this._shouldUpgrade(data.min_proxy_version)) {
        this.store.writeInbound({
          type: 'system',
          payload: {
            action: 'proxy_upgrade_required',
            min_version: data.min_proxy_version,
            current_version: PROXY_PROTOCOL_VERSION,
            upgrade_url: data.upgrade_url || null,
            message: data.upgrade_message || 'Proxy version is below the minimum required by Hub.',
          },
          channel: 'evomap-hub',
          priority: 'high',
        });
        this.logger.warn(`[lifecycle] Hub requires proxy >= ${data.min_proxy_version}, current: ${PROXY_PROTOCOL_VERSION}`);
      }

      return { ok: true, response: data };
    } catch (err) {
      this._consecutiveFailures++;
      this.logger.error(`[lifecycle] heartbeat failed (${this._consecutiveFailures}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  startHeartbeatLoop(intervalMs) {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();

    const interval = Math.max(30_000, intervalMs || DEFAULT_HEARTBEAT_INTERVAL);

    const tick = async () => {
      if (!this._running) return;
      await this.heartbeat();
      if (this._running) {
        const backoff = this._consecutiveFailures > 0
          ? Math.min(interval * Math.pow(2, this._consecutiveFailures), 30 * 60_000)
          : interval;
        this._heartbeatTimer = setTimeout(tick, backoff);
        if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
      }
    };

    tick();
  }

  stopHeartbeatLoop() {
    this._running = false;
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _shouldUpgrade(minVersion) {
    const parse = (v) => String(v || '0.0.0').split('.').map(part => parseInt(part, 10));
    const min = parse(minVersion);
    const cur = parse(PROXY_PROTOCOL_VERSION);
    for (let i = 0; i < 3; i++) {
      if ((cur[i] || 0) < (min[i] || 0)) return true;
      if ((cur[i] || 0) > (min[i] || 0)) return false;
    }
    return false;
  }
}

module.exports = { LifecycleManager, AuthError, DEFAULT_HEARTBEAT_INTERVAL };

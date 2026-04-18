'use strict';

// Wrapper around the original (obfuscated) a2aProtocol implementation.
//
// Why: the upstream implementation in this fork intermittently throws during
// heartbeat handling and does not reliably parse Hub event poll responses.
// This wrapper preserves the full public API surface while overriding only
// the broken heartbeat + Hub events buffering logic.

const fs = require('fs');
const path = require('path');

const base = require('./a2aProtocol.obf');

const HUB_EVENTS_BUFFER = [];
const HEARTBEAT_ACTIONS = [];
const AVAILABLE_WORK = [];

let _latestAvailableWork = [];
let _heartbeatTimer = null;

const HEARTBEAT_STATS = {
  okCount: 0,
  failCount: 0,
  consecutiveFailures: 0,
  lastOkAt: null,
  lastErrAt: null,
  lastError: null,
};

function _nowIso() {
  return new Date().toISOString();
}

function _timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch (_) {}
  return undefined;
}

function _hubUrlForHeartbeat() {
  // Keep behavior consistent with existing tests: heartbeat requires A2A_HUB_URL.
  return String(process.env.A2A_HUB_URL || '').trim();
}

function _normalizeHubUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function _getLoopLogPath() {
  const logsDir = String(process.env.EVOLVER_LOGS_DIR || '').trim();
  const dir = logsDir || process.cwd();
  return path.join(dir, 'evolver_loop.log');
}

function _touchLoopLog() {
  try {
    const p = _getLoopLogPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, '', 'utf8');
      return;
    }
    const now = new Date();
    fs.utimesSync(p, now, now);
  } catch (_) {}
}

function _safeHubHeaders() {
  // Prefer base implementation when present (it may include Authorization).
  let h = {};
  try {
    if (typeof base.buildHubHeaders === 'function') {
      h = base.buildHubHeaders() || {};
    }
  } catch (_) {}

  if (!h || typeof h !== 'object') h = {};
  if (!h['Content-Type'] && !h['content-type']) {
    h['Content-Type'] = 'application/json';
  }
  return h;
}

function _bufferHubEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    HUB_EVENTS_BUFFER.push(ev);

    // Best-effort: treat certain event types as "available work" for ATP loops.
    const t = String(ev.type || '').toLowerCase();
    if (t === 'task_available' || t === 'atp_order_available' || t === 'atp_order') {
      AVAILABLE_WORK.push(ev.payload || ev);
    }
  }
}

async function _pollHubEvents() {
  const hubUrl = _normalizeHubUrl(_hubUrlForHeartbeat());
  if (!hubUrl) return { ok: false, error: 'no_hub_url' };
  if (typeof fetch !== 'function') return { ok: false, error: 'fetch_not_available' };

  const nodeId = (typeof base.getNodeId === 'function') ? base.getNodeId() : (process.env.A2A_NODE_ID || null);

  const url = nodeId
    ? `${hubUrl}/a2a/events/poll?node_id=${encodeURIComponent(String(nodeId))}`
    : `${hubUrl}/a2a/events/poll`;

  const res = await fetch(url, {
    method: 'GET',
    headers: _safeHubHeaders(),
    signal: _timeoutSignal(15000),
  });

  const data = await res.json();

  const events = Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data?.payload?.events)
      ? data.payload.events
      : [];

  _bufferHubEvents(events);

  return { ok: true, eventsCount: events.length };
}

async function sendHeartbeat(opts) {
  const o = opts || {};
  const hubUrl = _normalizeHubUrl(_hubUrlForHeartbeat());
  if (!hubUrl) return { ok: false, error: 'no_hub_url' };
  if (typeof fetch !== 'function') return { ok: false, error: 'fetch_not_available' };

  const nodeId = (typeof base.getNodeId === 'function') ? base.getNodeId() : (process.env.A2A_NODE_ID || null);

  const url = `${hubUrl}/a2a/heartbeat`;

  try {
    const payload = {
      sender_id: nodeId || undefined,
      timestamp: _nowIso(),
      mode: o.mode || undefined,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: _safeHubHeaders(),
      body: JSON.stringify(payload),
      signal: _timeoutSignal(15000),
    });

    const data = await res.json();

    const ok = Boolean(data && (data.status === 'ok' || data.ok === true || res.ok));
    if (ok) {
      HEARTBEAT_STATS.okCount += 1;
      HEARTBEAT_STATS.consecutiveFailures = 0;
      HEARTBEAT_STATS.lastOkAt = _nowIso();
      HEARTBEAT_STATS.lastError = null;
      _touchLoopLog();

      const hasPending = Boolean(data.has_pending_events);
      if (hasPending) {
        HEARTBEAT_ACTIONS.push({ type: 'hub_pending_events', at: _nowIso() });
        // Fire-and-forget poll (tests expect this behavior).
        void _pollHubEvents().catch((err) => {
          HEARTBEAT_ACTIONS.push({ type: 'hub_events_poll_failed', at: _nowIso(), error: err?.message || String(err) });
        });
      }

      return { ok: true, data };
    }

    HEARTBEAT_STATS.failCount += 1;
    HEARTBEAT_STATS.consecutiveFailures += 1;
    HEARTBEAT_STATS.lastErrAt = _nowIso();
    HEARTBEAT_STATS.lastError = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500);

    return { ok: false, error: 'heartbeat_not_ok', data };
  } catch (err) {
    HEARTBEAT_STATS.failCount += 1;
    HEARTBEAT_STATS.consecutiveFailures += 1;
    HEARTBEAT_STATS.lastErrAt = _nowIso();
    HEARTBEAT_STATS.lastError = err?.message || String(err);

    return { ok: false, error: HEARTBEAT_STATS.lastError };
  }
}

function getHubEvents() {
  return HUB_EVENTS_BUFFER.slice();
}

function consumeHubEvents() {
  return HUB_EVENTS_BUFFER.splice(0, HUB_EVENTS_BUFFER.length);
}

function getHeartbeatStats() {
  return {
    ...HEARTBEAT_STATS,
    running: Boolean(_heartbeatTimer),
  };
}

function getHeartbeatActions() {
  return HEARTBEAT_ACTIONS.slice();
}

function consumeHeartbeatActions() {
  return HEARTBEAT_ACTIONS.splice(0, HEARTBEAT_ACTIONS.length);
}

function startHeartbeat(opts) {
  const o = opts || {};
  const intervalMs = Number.isFinite(Number(o.intervalMs))
    ? Number(o.intervalMs)
    : Number.isFinite(Number(process.env.A2A_HEARTBEAT_MS))
      ? Number(process.env.A2A_HEARTBEAT_MS)
      : 30000;

  if (_heartbeatTimer) {
    return { ok: true, alreadyRunning: true, intervalMs };
  }

  // Kick once immediately.
  void sendHeartbeat({ mode: o.mode }).catch(() => {});

  _heartbeatTimer = setInterval(() => {
    void sendHeartbeat({ mode: o.mode }).catch(() => {});
  }, Math.max(1000, intervalMs));

  return { ok: true, intervalMs };
}

function stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  return { ok: true };
}

function consumeAvailableWork() {
  const out = AVAILABLE_WORK.splice(0, AVAILABLE_WORK.length);
  _latestAvailableWork = out.slice();
  return out;
}

function getLatestAvailableWork() {
  return Array.isArray(_latestAvailableWork) ? _latestAvailableWork.slice() : [];
}

module.exports = {
  ...base,

  // Heartbeat + hub events overrides
  sendHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  getHeartbeatStats,
  getHeartbeatActions,
  consumeHeartbeatActions,
  getHubEvents,
  consumeHubEvents,
  consumeAvailableWork,
  getLatestAvailableWork,
};

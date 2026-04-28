'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CHANNEL = 'evomap-hub';
const SCHEMA_VERSION = 1;
const PROXY_PROTOCOL_VERSION = '0.1.0';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

// Merge `fields` into `target` while stripping keys that can mutate the
// prototype chain. Mailbox rows are persisted as JSONL and rebuilt on
// startup; without this filter a crafted messages.jsonl line containing
// __proto__/constructor/prototype could pollute Object.prototype during
// _rebuildIndex (see GHSA-2cjr-5v3h-v2w4).
function safeAssign(target, fields) {
  if (!fields || typeof fields !== 'object') return target;
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    target[k] = fields[k];
  }
  return target;
}

function sanitizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  safeAssign(out, row);
  if (out.fields && typeof out.fields === 'object') {
    const cleanFields = {};
    safeAssign(cleanFields, out.fields);
    out.fields = cleanFields;
  }
  return out;
}

// --- UUID v7 (RFC 9562) ---
// Bits 0-47: unix_ts_ms, Bits 48-51: ver=0b0111, Bits 52-63: rand_a,
// Bits 64-65: var=0b10, Bits 66-127: rand_b

function generateUUIDv7() {
  const now = Date.now();
  const msHex = now.toString(16).padStart(12, '0');

  const bytes = crypto.randomBytes(10);
  bytes[0] = (bytes[0] & 0x0f) | 0x70; // version 7
  bytes[2] = (bytes[2] & 0x3f) | 0x80; // variant 10

  const randHex = bytes.toString('hex');

  // Standard UUID format: 8-4-4-4-12 (32 hex total)
  return [
    msHex.slice(0, 8),
    msHex.slice(8, 12),
    randHex.slice(0, 4),
    randHex.slice(4, 8),
    randHex.slice(8, 20),
  ].join('-');
}

// --- JSONL file helpers ---

function safeParse(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return payload; }
}

function appendLine(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  try { fs.chmodSync(filePath, PRIVATE_FILE_MODE); } catch {}
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { results.push(JSON.parse(trimmed)); } catch { /* skip corrupt lines */ }
  }
  return results;
}

// --- In-memory index that backs JSONL persistence ---

class MailboxStore {
  constructor(dataDir) {
    if (!dataDir) throw new Error('dataDir is required');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try { fs.chmodSync(dataDir, PRIVATE_DIR_MODE); } catch {}
    this.dataDir = dataDir;

    this._messagesFile = path.join(dataDir, 'messages.jsonl');
    this._stateFile = path.join(dataDir, 'state.json');

    // in-memory indexes
    this._messages = new Map();          // id -> message object
    this._outbound = [];                 // ordered outbound refs (id)
    this._inbound = [];                  // ordered inbound refs (id)

    this._state = {};                    // key-value state (cursors, node_id, etc.)

    this._loadState();
    this._rebuildIndex();
  }

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        this._state = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
      }
    } catch {
      this._state = {};
    }
    const existingVersion = this._state._schema_version || 0;
    if (existingVersion < SCHEMA_VERSION) {
      this._runMigrations(existingVersion, SCHEMA_VERSION);
    }
    this._state._schema_version = SCHEMA_VERSION;
    this._persistState();
  }

  _runMigrations(fromVersion, toVersion) {
    for (let v = fromVersion + 1; v <= toVersion; v++) {
      const migrator = MIGRATIONS[v];
      if (typeof migrator === 'function') {
        migrator(this);
      }
    }
  }

  _persistState() {
    const dir = path.dirname(this._stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${this._stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, this._stateFile);
    try { fs.chmodSync(this._stateFile, PRIVATE_FILE_MODE); } catch {}
  }

  _rebuildIndex() {
    this._messages.clear();
    this._outbound = [];
    this._inbound = [];

    const TERMINAL = new Set(['synced', 'delivered', 'failed', 'rejected']);
    const rows = readLines(this._messagesFile);
    for (const rawRow of rows) {
      const row = sanitizeRow(rawRow);
      if (row._op === 'update') {
        const existing = this._messages.get(row.id);
        if (existing) safeAssign(existing, row.fields);
        continue;
      }
      this._messages.set(row.id, row);
    }
    for (const [id, msg] of this._messages) {
      if (TERMINAL.has(msg.status)) continue;
      if (msg.direction === 'outbound') this._outbound.push(id);
      else if (msg.direction === 'inbound') this._inbound.push(id);
    }
  }

  _appendMessage(msg) {
    appendLine(this._messagesFile, msg);
    this._messages.set(msg.id, msg);
    if (msg.direction === 'outbound') this._outbound.push(msg.id);
    else if (msg.direction === 'inbound') this._inbound.push(msg.id);
  }

  _appendUpdate(id, fields) {
    appendLine(this._messagesFile, { _op: 'update', id, fields });
    const existing = this._messages.get(id);
    if (existing) safeAssign(existing, fields);
  }

  _evictFromIndex(id) {
    const msg = this._messages.get(id);
    if (!msg) return;
    const arr = msg.direction === 'outbound' ? this._outbound : this._inbound;
    const idx = arr.indexOf(id);
    if (idx !== -1) arr.splice(idx, 1);
  }

  // --- Public API: send / writeInbound ---

  send({ type, payload, channel, priority, refId, expiresAt }) {
    const id = generateUUIDv7();
    const now = Date.now();
    const msg = {
      id,
      channel: channel || DEFAULT_CHANNEL,
      direction: 'outbound',
      type,
      status: 'pending',
      payload: safeParse(payload),
      priority: priority || 'normal',
      ref_id: refId || null,
      created_at: now,
      synced_at: null,
      expires_at: expiresAt || null,
      retry_count: 0,
      error: null,
    };
    this._appendMessage(msg);
    return { message_id: id, status: 'pending' };
  }

  writeInbound({ id, type, payload, channel, priority, refId, expiresAt }) {
    const msgId = id || generateUUIDv7();
    // At-least-once delivery from the Hub / retry loops can send the same
    // message id twice. Without idempotency, poll() and countPending() would
    // double-count the retry. See community PR #515.
    if (this._messages.has(msgId)) return msgId;

    const now = Date.now();
    const msg = {
      id: msgId,
      channel: channel || DEFAULT_CHANNEL,
      direction: 'inbound',
      type,
      status: 'pending',
      payload: safeParse(payload),
      priority: priority || 'normal',
      ref_id: refId || null,
      created_at: now,
      synced_at: null,
      expires_at: expiresAt || null,
      retry_count: 0,
      error: null,
    };
    this._appendMessage(msg);
    return msgId;
  }

  writeInboundBatch(messages) {
    const ids = [];
    for (const m of messages) {
      ids.push(this.writeInbound(m));
    }
    return ids;
  }

  // --- Public API: query ---

  getById(id) {
    const msg = this._messages.get(id);
    return msg ? { ...msg } : null;
  }

  poll({ channel, type, limit } = {}) {
    const max = Math.max(1, Math.min(limit || 20, 100));
    const results = [];
    for (const id of this._inbound) {
      if (results.length >= max) break;
      const msg = this._messages.get(id);
      if (!msg || msg.status !== 'pending') continue;
      if (channel && msg.channel !== channel) continue;
      if (type && msg.type !== type) continue;
      results.push({ ...msg });
    }
    return results;
  }

  pollOutbound({ channel, limit } = {}) {
    const ch = channel || DEFAULT_CHANNEL;
    const max = Math.max(1, Math.min(limit || 50, 200));
    const results = [];

    const priorityOrder = { high: 0, normal: 1, low: 2 };
    const candidates = [];
    for (const id of this._outbound) {
      const msg = this._messages.get(id);
      if (!msg || msg.status !== 'pending') continue;
      if (msg.channel !== ch) continue;
      candidates.push(msg);
    }
    candidates.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created_at - b.created_at;
    });
    for (let i = 0; i < Math.min(candidates.length, max); i++) {
      results.push({ ...candidates[i] });
    }
    return results;
  }

  // --- Public API: status updates ---

  ack(messageIds) {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    let count = 0;
    for (const id of ids) {
      const msg = this._messages.get(id);
      if (msg && msg.direction === 'inbound') {
        this._appendUpdate(id, { status: 'delivered' });
        this._evictFromIndex(id);
        count++;
      }
    }
    return count;
  }

  updateStatus(id, status, { error, syncedAt } = {}) {
    const TERMINAL = new Set(['synced', 'delivered', 'failed', 'rejected']);
    const fields = { status };
    if (syncedAt) fields.synced_at = syncedAt;
    else if (status === 'synced') fields.synced_at = Date.now();
    if (error !== undefined) fields.error = error;
    else if (status !== 'failed' && status !== 'rejected') fields.error = null;
    this._appendUpdate(id, fields);
    if (TERMINAL.has(status)) {
      this._evictFromIndex(id);
    }
  }

  updateStatusBatch(updates) {
    for (const u of updates) {
      this.updateStatus(u.id, u.status, { error: u.error, syncedAt: u.syncedAt });
    }
  }

  incrementRetry(id, error) {
    const msg = this._messages.get(id);
    const newCount = msg ? (msg.retry_count || 0) + 1 : 1;
    this._appendUpdate(id, { retry_count: newCount, error: error || null });
  }

  list({ type, direction, status, limit, offset } = {}) {
    if (!type) throw new Error('type is required for list()');
    const max = Math.max(1, Math.min(limit || 20, 100));
    const skip = Math.max(0, offset || 0);

    const all = [];
    for (const [, msg] of this._messages) {
      if (type !== '%' && msg.type !== type) continue;
      if (direction && msg.direction !== direction) continue;
      if (status && msg.status !== status) continue;
      all.push(msg);
    }
    all.sort((a, b) => b.created_at - a.created_at);
    return all.slice(skip, skip + max).map(m => ({ ...m }));
  }

  countPending({ direction, channel } = {}) {
    const dir = direction || 'outbound';
    let count = 0;
    const idList = dir === 'outbound' ? this._outbound : this._inbound;
    for (const id of idList) {
      const msg = this._messages.get(id);
      if (!msg || msg.status !== 'pending') continue;
      if (channel && msg.channel !== channel) continue;
      count++;
    }
    return count;
  }

  // --- Public API: state / cursors ---

  getCursor(key) {
    const val = this._state[`cursor:${key}`];
    return val !== undefined ? val : null;
  }

  setCursor(key, value) {
    this._state[`cursor:${key}`] = value;
    this._persistState();
  }

  getState(key) {
    const val = this._state[key];
    return val !== undefined ? val : null;
  }

  setState(key, value) {
    this._state[key] = typeof value === 'string' ? value : JSON.stringify(value);
    this._persistState();
  }

  // --- Compaction (reduces JSONL file size by rewriting only current state) ---

  compact() {
    const tmpFile = this._messagesFile + '.tmp';
    const entries = [];
    for (const [, msg] of this._messages) {
      entries.push(msg);
    }
    entries.sort((a, b) => a.created_at - b.created_at);

    const fd = fs.openSync(tmpFile, 'w');
    for (const msg of entries) {
      fs.writeSync(fd, JSON.stringify(msg) + '\n');
    }
    fs.closeSync(fd);
    fs.renameSync(tmpFile, this._messagesFile);
    this._rebuildIndex();
  }

  close() {
    // no-op for JSONL (no file handles to close), but kept for API compatibility
  }
}

// Migration registry: key = target schema version, value = function(store)
// Each migration mutates in-memory state or rewrites JSONL as needed.
// Add new entries when SCHEMA_VERSION is bumped.
const MIGRATIONS = {
  // version 1 is the initial schema -- no migration needed from 0 (fresh install)
};

module.exports = { MailboxStore, generateUUIDv7, DEFAULT_CHANNEL, SCHEMA_VERSION, PROXY_PROTOCOL_VERSION };

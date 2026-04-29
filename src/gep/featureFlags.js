// Feature flags persistence layer.
//
// Provides three-tier override semantics (read by callers):
//   1. Local env (highest priority, user escape hatch)
//   2. Persisted flag from disk (set by hub mailbox or manual write)
//   3. Code default (lowest priority)
//
// File location: ~/.evomap/feature_flags.json (same dir as node_id / node_secret).
// Schema: { "<key>": { value: any, source: string, updatedAt: ISO8601 } }
//
// Whitelist enforcement happens at the caller (HUB_EVENT_HANDLERS).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAGS_DIR = path.join(os.homedir(), '.evomap');
const FLAGS_FILE = path.join(FLAGS_DIR, 'feature_flags.json');
const LOCAL_FLAGS_FILE = path.resolve(__dirname, '..', '..', '.evomap_feature_flags.json');
const ALLOWED_FLAGS = new Map([
  ['validator_enabled', function (value) { return typeof value === 'boolean'; }],
]);

let _cache = null;
let _cacheLoaded = false;

function _normalizeSource(source) {
  return typeof source === 'string' && source ? source.trim().toLowerCase() : 'unknown';
}

function _isHubSource(source) {
  return source === 'hub_mailbox' || source === 'hub_event' || source === 'hub';
}

function _isHubFeatureFlagsEnabled() {
  const raw = String(process.env.EVOLVER_ENABLE_HUB_FEATURE_FLAGS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function _readFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) {}
  return null;
}

function _loadFromDisk() {
  if (_cacheLoaded) return _cache;
  _cacheLoaded = true;
  _cache = _readFile(FLAGS_FILE) || _readFile(LOCAL_FLAGS_FILE) || {};
  return _cache;
}

function _writeToDisk(obj) {
  try {
    if (!fs.existsSync(FLAGS_DIR)) {
      fs.mkdirSync(FLAGS_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(FLAGS_FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (_) {}
  try {
    fs.writeFileSync(LOCAL_FLAGS_FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (_) {}
  return false;
}

/**
 * Read a persisted feature flag value. Returns undefined if not set.
 * @param {string} key
 * @returns {any|undefined}
 */
function readFeatureFlag(key) {
  if (!key || typeof key !== 'string') return undefined;
  const all = _loadFromDisk();
  const entry = all[key];
  if (!entry || typeof entry !== 'object') return undefined;
  return entry.value;
}

/**
 * Persist a feature flag. Returns true on success.
 * @param {string} key
 * @param {any} value
 * @param {string} [source] - origin tag, e.g. "hub_mailbox", "manual"
 */
function writeFeatureFlag(key, value, source) {
  if (!key || typeof key !== 'string') return false;
  const validator = ALLOWED_FLAGS.get(key);
  if (typeof validator !== 'function' || !validator(value)) return false;
  const normalizedSource = _normalizeSource(source);
  if (_isHubSource(normalizedSource) && !_isHubFeatureFlagsEnabled()) return false;
  const all = _loadFromDisk();
  all[key] = {
    value,
    source: normalizedSource,
    updatedAt: new Date().toISOString(),
  };
  const ok = _writeToDisk(all);
  if (ok) _cache = all;
  return ok;
}

/**
 * Returns the full flags object (read-only view). For diagnostics/tests.
 */
function getAllFeatureFlags() {
  const all = _loadFromDisk();
  return JSON.parse(JSON.stringify(all));
}

/**
 * Reset the in-process cache. Test-only.
 */
function _resetCacheForTests() {
  _cache = null;
  _cacheLoaded = false;
}

module.exports = {
  readFeatureFlag,
  writeFeatureFlag,
  getAllFeatureFlags,
  _resetCacheForTests,
  FLAGS_FILE,
  LOCAL_FLAGS_FILE,
  ALLOWED_FLAGS,
};

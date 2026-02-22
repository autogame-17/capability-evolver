// Content-addressable hashing for GEP assets.
// Provides canonical JSON serialization and SHA-256 based asset IDs.
// This enables deduplication, tamper detection, and cross-node consistency.

const crypto = require('crypto');

// Schema version for all GEP asset types.
// Bump MINOR for additive fields; MAJOR for breaking changes.
const SCHEMA_VERSION = '1.6.0';

// Canonical JSON: deterministic serialization with sorted keys at all levels.
// Arrays preserve order; non-finite numbers become null; undefined becomes null.
function canonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return 'null';
    return String(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = [];
    for (const k of keys) {
      pairs.push(JSON.stringify(k) + ':' + canonicalize(obj[k]));
    }
    return '{' + pairs.join(',') + '}';
  }
  return 'null';
}

// Compute a content-addressable asset ID.
// Excludes self-referential fields (asset_id itself) from the hash input.
// Returns "sha256:<hex>".
function computeAssetId(obj, excludeFields) {
  if (!obj || typeof obj !== 'object') return null;
  const exclude = new Set(Array.isArray(excludeFields) ? excludeFields : ['asset_id']);
  const clean = {};
  for (const k of Object.keys(obj)) {
    if (exclude.has(k)) continue;
    clean[k] = obj[k];
  }
  const canonical = canonicalize(clean);
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return 'sha256:' + hash;
}

// Verify that an object's asset_id matches its content.
function verifyAssetId(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const claimed = obj.asset_id;
  if (!claimed || typeof claimed !== 'string') return false;
  const computed = computeAssetId(obj);
  return claimed === computed;
}

module.exports = {
  SCHEMA_VERSION,
  canonicalize,
  computeAssetId,
  verifyAssetId,
};

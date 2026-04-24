'use strict';
// JSONL log rotation helper.
//
// Rotates a JSONL file when it exceeds maxSizeBytes by renaming it to a
// timestamped archive and starting a fresh empty file. Old archives beyond
// maxArchives are deleted so disk usage stays bounded.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_ARCHIVES = 5;

function _archiveSuffix() {
  return '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak';
}

function _cleanOldArchives(dir, baseName, maxArchives) {
  try {
    const prefix = baseName + '.';
    const entries = fs.readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.bak'));
    entries.sort();
    const toDelete = entries.slice(0, Math.max(0, entries.length - maxArchives));
    for (const name of toDelete) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Rotate `filePath` if its size exceeds `maxSizeBytes`.
 * Safe to call on every append — stat is cheap and rotation is rare.
 *
 * @param {string} filePath
 * @param {{ maxSizeBytes?: number, maxArchives?: number }} [opts]
 * @returns {boolean} true if rotation occurred
 */
function rotateIfNeeded(filePath, opts) {
  const maxSizeBytes = (opts && opts.maxSizeBytes > 0) ? opts.maxSizeBytes : DEFAULT_MAX_SIZE_BYTES;
  const maxArchives = (opts && opts.maxArchives > 0) ? opts.maxArchives : DEFAULT_MAX_ARCHIVES;

  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < maxSizeBytes) return false;

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const archivePath = path.join(dir, baseName + _archiveSuffix());
    fs.renameSync(filePath, archivePath);
    _cleanOldArchives(dir, baseName, maxArchives);
    return true;
  } catch (err) {
    console.warn('[logRotation] rotateIfNeeded failed for ' + filePath + ':', err && err.message || err);
    return false;
  }
}

module.exports = { rotateIfNeeded, DEFAULT_MAX_SIZE_BYTES, DEFAULT_MAX_ARCHIVES };

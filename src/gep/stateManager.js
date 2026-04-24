'use strict';
// WAL-based state manager for JSON state files.
//
// Pattern: write wal → fsync-equivalent (via rename) → write main → delete wal
// On readState(): if a .wal file exists, the previous write did not complete
// cleanly; the WAL content is the authoritative value and is applied first.
//
// This prevents silent state corruption when the process is killed mid-write.

const fs = require('fs');
const path = require('path');

function _walPath(filePath) {
  return filePath + '.wal';
}

function _writeSafe(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read state from `filePath`, recovering from an incomplete WAL if present.
 *
 * @param {string} filePath
 * @param {*} defaultValue  Returned when file is absent or unreadable.
 * @returns {*}
 */
function readState(filePath, defaultValue) {
  const wal = _walPath(filePath);
  // Recover from incomplete previous write: WAL present means the main file
  // write was not reached — commit the WAL content now.
  if (fs.existsSync(wal)) {
    try {
      const walContent = fs.readFileSync(wal, 'utf8').trim();
      if (walContent) {
        _writeSafe(filePath, walContent + '\n');
      }
    } catch (err) {
      console.warn('[stateManager] WAL recovery failed for ' + filePath + ':', err && err.message || err);
    }
    try { fs.unlinkSync(wal); } catch (_) {}
  }
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[stateManager] Failed to read ' + filePath + ':', err && err.message || err);
    return defaultValue;
  }
}

/**
 * Write `obj` to `filePath` atomically using a WAL.
 * Guarantees that either the old or the new value survives a crash.
 *
 * @param {string} filePath
 * @param {*} obj
 */
function writeState(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const serialized = JSON.stringify(obj, null, 2);
  const wal = _walPath(filePath);
  // Step 1: write WAL (crash before this → no change; old value intact)
  _writeSafe(wal, serialized);
  // Step 2: write main file (crash before this → WAL recovery on next read)
  _writeSafe(filePath, serialized + '\n');
  // Step 3: delete WAL (crash here → harmless double-write on next read)
  try { fs.unlinkSync(wal); } catch (_) {}
}

module.exports = { readState, writeState };

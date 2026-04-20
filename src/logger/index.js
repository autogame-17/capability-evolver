'use strict';
// Structured JSON logger for Evolver.
// Replaces console.log scatter with level-aware, module-tagged output.
// In loop mode (EVOLVE_LOOP=true): writes JSON lines to the log file.
// In CLI mode: writes JSON lines to stdout/stderr.
// Zero external dependencies.

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LEVEL_NAMES = Object.keys(LEVELS);

function resolveLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase().trim();
  return raw in LEVELS ? raw : 'info';
}

let _logFd = null;
let _logPath = null;

function getLogFd() {
  if (_logFd !== null) return _logFd;
  if (process.env.EVOLVE_LOOP !== 'true') return null;
  try {
    const { getEvolverLogPath } = require('../gep/paths');
    _logPath = getEvolverLogPath();
    const dir = path.dirname(_logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _logFd = fs.openSync(_logPath, 'a');
  } catch (e) {
    _logFd = null;
  }
  return _logFd;
}

function write(levelName, module, message, extra) {
  const currentLevel = resolveLevel();
  if (LEVELS[levelName] > LEVELS[currentLevel]) return;

  const entry = Object.assign({
    ts: new Date().toISOString(),
    level: levelName,
    module: String(module || 'evolver'),
    msg: String(message),
  }, extra && typeof extra === 'object' ? extra : {});

  const line = JSON.stringify(entry) + '\n';
  const fd = getLogFd();
  if (fd !== null) {
    try { fs.writeSync(fd, line); } catch (_) {}
  } else {
    const stream = LEVELS[levelName] <= LEVELS.warn ? process.stderr : process.stdout;
    stream.write(line);
  }
}

function createLogger(module) {
  const m = String(module || 'evolver');
  return {
    error: (msg, extra) => write('error', m, msg, extra),
    warn:  (msg, extra) => write('warn',  m, msg, extra),
    info:  (msg, extra) => write('info',  m, msg, extra),
    debug: (msg, extra) => write('debug', m, msg, extra),
    trace: (msg, extra) => write('trace', m, msg, extra),
  };
}

// Root logger for one-off use without module scoping
const rootLogger = createLogger('evolver');

module.exports = { createLogger, LEVELS, LEVEL_NAMES, ...rootLogger };

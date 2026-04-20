// src/gep/validator/sandboxExecutor.js
//
// Runs validation commands provided by the Hub inside an isolated sandbox
// directory with strict resource/time limits, and does NOT trust the capsule
// or gene payload -- we only execute commands exactly as Hub sent them,
// inside a fresh empty working directory, with network blocked by convention
// and output truncated to a small size.
//
// Security posture:
//  - Never run inside the evolver's own workspace or repo root.
//  - Create a fresh temp directory per task; wipe after execution.
//  - Per-command timeout defaults to 60s, hard cap 120s.
//  - Total batch timeout defaults to 180s.
//  - Collect stdout/stderr truncated to 4000 chars each to match
//    ValidationReport.command.stdout/stderr schema on the Hub.
//  - Commands are parsed into argv arrays and spawned with shell:false
//    to eliminate shell injection risk entirely.
//
// This module is intentionally simple and has no external dependencies.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_CMD_TIMEOUT_MS = 60_000;
const MAX_CMD_TIMEOUT_MS = 120_000;
const DEFAULT_BATCH_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 4000;

const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx']);

function safeNumber(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Parse a command string into { executable, args } without invoking a shell.
// Handles single and double quoted segments; strips surrounding quotes.
// Throws if the executable is not in ALLOWED_EXECUTABLES.
function parseCommand(cmdString) {
  const parts = [];
  let current = '';
  let inQuote = null;
  for (const ch of String(cmdString)) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = ch;
    } else if (inQuote && ch === inQuote) {
      inQuote = null;
    } else if (!inQuote && ch === ' ') {
      if (current.length > 0) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  if (parts.length === 0) throw new Error('sandbox: empty command');

  // Normalise: accept 'node', '/usr/bin/node', 'node.exe' — compare basename
  const rawExe = parts[0];
  const baseName = rawExe.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  if (!ALLOWED_EXECUTABLES.has(baseName)) {
    throw new Error(`sandbox: executable not allowed: ${rawExe}`);
  }
  return { executable: rawExe, args: parts.slice(1) };
}

function truncate(str, limit) {
  if (typeof str !== 'string') return '';
  if (str.length <= limit) return str;
  return str.slice(0, limit) + '\n...[truncated]';
}

function createSandboxDir() {
  const base = path.join(os.tmpdir(), 'evolver-validator');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  const name = 'task_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // non-fatal
  }
}

function buildSandboxEnv() {
  // Minimal env: no secrets, no proxy, TMPDIR isolated, PATH kept.
  const base = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    NODE_ENV: 'sandbox',
    EVOLVER_SANDBOX: '1',
  };
  // Explicitly block common outbound-config envs.
  return base;
}

function runSingleCommand(cmd, opts) {
  const options = opts || {};
  const timeoutMs = Math.min(
    safeNumber(options.timeoutMs, DEFAULT_CMD_TIMEOUT_MS),
    MAX_CMD_TIMEOUT_MS,
  );
  const cwd = options.cwd;
  const env = buildSandboxEnv();

  return new Promise((resolve) => {
    let child;
    try {
      const { executable, args } = parseCommand(cmd);
      child = spawn(executable, args, {
        shell: false,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        cmd: String(cmd),
        ok: false,
        stdout: '',
        stderr: 'spawn_failed: ' + (err && err.message ? err.message : String(err)),
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      if (!settled) {
        settled = true;
        resolve({
          cmd: String(cmd),
          ok: false,
          stdout: truncate(stdout, MAX_OUTPUT_CHARS),
          stderr: truncate(stderr + '\n[killed by sandbox timeout]', MAX_OUTPUT_CHARS),
          exitCode: -1,
          durationMs: Date.now() - startedAt,
          timedOut: true,
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS * 2);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > MAX_OUTPUT_CHARS * 2) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS * 2);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        cmd: String(cmd),
        ok: false,
        stdout: truncate(stdout, MAX_OUTPUT_CHARS),
        stderr: truncate(stderr + '\n' + (err && err.message ? err.message : String(err)), MAX_OUTPUT_CHARS),
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = typeof code === 'number' ? code : (signal ? -1 : -1);
      resolve({
        cmd: String(cmd),
        ok: exitCode === 0,
        stdout: truncate(stdout, MAX_OUTPUT_CHARS),
        stderr: truncate(stderr, MAX_OUTPUT_CHARS),
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

/**
 * Run a list of validation commands in a fresh sandbox directory.
 * Stops at the first failure and returns partial results.
 *
 * @param {string[]} commands
 * @param {{ cmdTimeoutMs?: number, batchTimeoutMs?: number, keepSandbox?: boolean }} [opts]
 * @returns {Promise<{
 *   results: Array<{ cmd: string, ok: boolean, stdout: string, stderr: string, exitCode: number, durationMs: number, timedOut: boolean }>,
 *   overallOk: boolean,
 *   sandboxDir: string,
 *   durationMs: number,
 *   stoppedEarly: boolean,
 * }>}
 */
async function runInSandbox(commands, opts) {
  const options = opts || {};
  const cmds = Array.isArray(commands) ? commands.filter((c) => typeof c === 'string' && c.trim()) : [];
  const startedAt = Date.now();

  if (cmds.length === 0) {
    return {
      results: [],
      overallOk: false,
      sandboxDir: null,
      durationMs: 0,
      stoppedEarly: false,
      reason: 'no_commands',
    };
  }

  const batchTimeoutMs = Math.min(
    safeNumber(options.batchTimeoutMs, DEFAULT_BATCH_TIMEOUT_MS),
    DEFAULT_BATCH_TIMEOUT_MS * 3,
  );

  const sandboxDir = createSandboxDir();
  const results = [];
  let stoppedEarly = false;

  try {
    for (const cmd of cmds) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= batchTimeoutMs) {
        stoppedEarly = true;
        break;
      }
      const remaining = batchTimeoutMs - elapsed;
      const r = await runSingleCommand(cmd, {
        cwd: sandboxDir,
        timeoutMs: Math.min(
          safeNumber(options.cmdTimeoutMs, DEFAULT_CMD_TIMEOUT_MS),
          remaining,
        ),
      });
      results.push(r);
      if (!r.ok) {
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    if (!options.keepSandbox) cleanupDir(sandboxDir);
  }

  const overallOk = results.length > 0 && results.every((r) => r.ok) && !stoppedEarly;

  return {
    results,
    overallOk,
    sandboxDir: options.keepSandbox ? sandboxDir : null,
    durationMs: Date.now() - startedAt,
    stoppedEarly,
  };
}

module.exports = {
  runInSandbox,
  runSingleCommand,
  createSandboxDir,
  cleanupDir,
  buildSandboxEnv,
  parseCommand,
  ALLOWED_EXECUTABLES,
  DEFAULT_CMD_TIMEOUT_MS,
  MAX_CMD_TIMEOUT_MS,
  DEFAULT_BATCH_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
};

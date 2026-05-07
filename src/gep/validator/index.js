// src/gep/validator/index.js
//
// Validator mode entry-point. Feature-gated by EVOLVER_VALIDATOR_ENABLED.
// Intended usage: called once per evolve cycle, it will fetch assigned
// validation tasks from the Hub, execute the provided commands in a
// sandbox, and submit a ValidationReport back to the Hub.
//
// Failure modes are all non-fatal -- a validator that cannot reach the Hub
// or cannot sandbox-execute will simply skip and try again next cycle.
'use strict';

const { getNodeId, buildHubHeaders, getHubUrl } = require('../a2aProtocol');
const { runInSandbox, runPreflight } = require('./sandboxExecutor');
const { buildReportPayload, submitReport } = require('./reporter');
const { ensureValidatorStake } = require('./stakeBootstrap');
const { readFeatureFlag } = require('../featureFlags');
const { resolveHubUrl: resolveDefaultHubUrl } = require('../../config');

const FETCH_TIMEOUT_MS = Number(process.env.EVOLVER_VALIDATOR_FETCH_TIMEOUT_MS) || 8_000;
const MAX_TASKS_PER_CYCLE = Math.max(1, Number(process.env.EVOLVER_VALIDATOR_MAX_TASKS_PER_CYCLE) || 2);

// Three-tier resolution:
//   1. Local env (highest priority - user escape hatch). Both ON and OFF are honored.
//   2. Persisted feature flag from disk (set by hub mailbox).
//   3. Code default: ON (validator role is opt-out as of v1.69.0).
function isValidatorEnabled() {
  const raw = String(process.env.EVOLVER_VALIDATOR_ENABLED || '').toLowerCase().trim();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  try {
    const flag = readFeatureFlag('validator_enabled');
    if (typeof flag === 'boolean') return flag;
  } catch (_) {}
  return true;
}

function resolveHubUrl() {
  try {
    const u = getHubUrl && getHubUrl();
    if (u && typeof u === 'string') return u;
  } catch (_) {}
  return resolveDefaultHubUrl();
}

/**
 * Fetch validation tasks assigned to this node.
 */
async function fetchValidationTasks() {
  const nodeId = getNodeId();
  if (!nodeId) return [];
  const hubUrl = resolveHubUrl();
  const url = hubUrl.replace(/\/+$/, '') + '/a2a/fetch';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const msg = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: 'fetch',
    message_id: 'msg_' + Date.now().toString(36),
    sender_id: nodeId,
    timestamp: new Date().toISOString(),
    payload: {
      // tasks_only short-circuits the Hub's asset search + GDI credit charge.
      // Pre-v1.77.0 this sent `validation_only: true`, which Hub ignored,
      // causing ~96 credits per 15s poll to be deducted from the owner. Keep
      // validation_only as a belt-and-suspenders hint for newer Hubs that
      // understand it; tasks_only is the universal no-charge switch.
      tasks_only: true,
      validation_only: true,
      include_tasks: true,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHubHeaders(),
      body: JSON.stringify(msg),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    const p = data.payload || data;
    const list = Array.isArray(p.validation_tasks) ? p.validation_tasks : [];
    return list;
  } catch (_) {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Validate a single task.
 * @param {object} task - Hub-provided validation task
 * @returns {Promise<{ status: string, report?: object, response?: object, reason?: string }>}
 */
async function validateOneTask(task) {
  if (!task || !task.task_id || !task.nonce) {
    return { status: 'skipped', reason: 'invalid_task_shape' };
  }
  const commands = Array.isArray(task.validation_commands) ? task.validation_commands : [];
  if (commands.length === 0) {
    // Nothing to run -- report overall_ok=false so the Hub records a fail and moves on.
    const payload = buildReportPayload(task, { results: [], overallOk: false, durationMs: 0 });
    const r = await submitReport(payload);
    return { status: 'reported_empty', report: payload, response: r };
  }

  let execution;
  try {
    execution = await runInSandbox(commands, {});
  } catch (err) {
    execution = {
      results: [{
        cmd: commands[0],
        ok: false,
        stdout: '',
        stderr: 'sandbox_error: ' + (err && err.message ? err.message : String(err)),
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
      }],
      overallOk: false,
      durationMs: 0,
      stoppedEarly: true,
    };
  }

  const payload = buildReportPayload(task, execution);
  const response = await submitReport(payload);
  return {
    status: response && response.ok ? 'reported' : 'report_failed',
    report: payload,
    response,
  };
}

// Lazy single-shot preflight cache. Runs once per process, reused by both the
// daemon and the inline runValidatorCycle() called from the main evolve loop.
let _preflightPromise = null;
let _preflightResult = null;

async function _ensurePreflight() {
  if (_preflightResult) return _preflightResult;
  if (_preflightPromise) return _preflightPromise;
  _preflightPromise = (async () => {
    try {
      _preflightResult = await runPreflight();
    } catch (err) {
      _preflightResult = {
        ok: false,
        reason: 'preflight_threw',
        durationMs: 0,
        stderrTail: err && err.message ? String(err.message) : String(err),
      };
    }
    _daemonStats.preflight = {
      ok: !!_preflightResult.ok,
      reason: _preflightResult.reason || null,
      duration_ms: _preflightResult.durationMs || 0,
      at: Date.now(),
    };
    if (!_preflightResult.ok) {
      _preflightDisabled = true;
      try {
        console.warn(
          '[Validator] Preflight FAILED (' + (_preflightResult.reason || 'unknown') + '): ' +
          'cannot spawn `node <script>` inside the sandbox on this host. ' +
          'Validator role is being SKIPPED to avoid flooding the Hub with env_fail reports. ' +
          'Likely causes: node binary not on PATH for headless invocations, missing exec perm, ' +
          'or unwritable TMPDIR. Diagnostic stderr: ' + (_preflightResult.stderrTail || '<empty>')
        );
      } catch (_) { /* console unavailable -- non-fatal */ }
    }
    return _preflightResult;
  })();
  return _preflightPromise;
}

/**
 * Run one validator cycle. Intended to be called from the main evolve loop.
 * Returns a summary object (useful for logging/tests).
 *
 * @param {{ skipStake?: boolean }} [opts]
 */
async function runValidatorCycle(opts) {
  const options = opts || {};
  if (!isValidatorEnabled()) {
    return { skipped: 'disabled' };
  }
  // Lazy preflight gate: refuse to talk to the Hub if the local toolchain
  // cannot even run a trivial `node <script>` in the sandbox. Without this,
  // every validation task posted to this node returns duration_ms=1 /
  // commands_passed=0 and the Hub auto-quarantines the node for chronic
  // env_fail.
  const pf = await _ensurePreflight();
  if (!pf.ok) {
    return { skipped: 'preflight_failed', reason: pf.reason || 'unknown' };
  }
  if (!options.skipStake) {
    try {
      await ensureValidatorStake({});
    } catch (err) {
      // non-fatal -- stake may already exist or will retry later
    }
  }

  const tasks = await fetchValidationTasks();
  if (!tasks || tasks.length === 0) {
    return { tasks: 0, processed: 0 };
  }

  const slice = tasks.slice(0, MAX_TASKS_PER_CYCLE);
  const outcomes = [];
  for (const t of slice) {
    try {
      const outcome = await validateOneTask(t);
      outcomes.push({ task_id: t.task_id, ...outcome });
    } catch (err) {
      outcomes.push({
        task_id: t.task_id,
        status: 'error',
        reason: err && err.message ? err.message : String(err),
      });
    }
  }
  return { tasks: tasks.length, processed: outcomes.length, outcomes };
}

// --- Background daemon ---
//
// In long-running modes (--loop / --mad-dog) the validator role used to share
// the main evolve loop and was suppressed by idle gating (skipHubCalls) when
// the host was saturated. The daemon runs independently on its own timer so
// that validator participation does not depend on the agent's foreground load.

function _envIntDefault(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const DAEMON_INTERVAL_MS = Math.max(15000, _envIntDefault('EVOLVER_VALIDATOR_DAEMON_INTERVAL_MS', 60000));
const DAEMON_FIRST_DELAY_MS = Math.max(0, _envIntDefault('EVOLVER_VALIDATOR_DAEMON_FIRST_DELAY_MS', 30000));

let _daemonTimer = null;
let _daemonRunning = false;
let _daemonInflight = false;
let _daemonStats = { ticks: 0, processed: 0, lastError: null, lastRunAt: 0, preflight: null };
let _preflightDisabled = false;

async function _daemonTick() {
  if (_daemonInflight) return;
  _daemonInflight = true;
  try {
    if (!isValidatorEnabled()) {
      _daemonStats.ticks += 1;
      return;
    }
    if (_preflightDisabled) {
      // Preflight failed during startup -- stay silent. We still tick so the
      // operator can re-enable later by restarting the agent after fixing PATH.
      _daemonStats.ticks += 1;
      return;
    }
    const out = await runValidatorCycle({});
    _daemonStats.ticks += 1;
    _daemonStats.lastRunAt = Date.now();
    if (out && typeof out.processed === 'number') {
      _daemonStats.processed += out.processed;
      if (out.processed > 0) {
        console.log('[ValidatorDaemon] processed ' + out.processed + '/' + (out.tasks || 0) + ' task(s).');
      }
    }
  } catch (err) {
    _daemonStats.lastError = err && err.message || String(err);
    console.warn('[ValidatorDaemon] tick failed (non-fatal): ' + _daemonStats.lastError);
  } finally {
    _daemonInflight = false;
    if (_daemonRunning) {
      _daemonTimer = setTimeout(_daemonTick, DAEMON_INTERVAL_MS);
    }
  }
}

/**
 * Start an independent validator daemon. Safe to call once at process boot
 * from --loop / --mad-dog modes. No-op if already running.
 */
function startValidatorDaemon() {
  if (_daemonRunning) return false;
  _daemonRunning = true;
  if (isValidatorEnabled()) {
    // Surface an explicit notice every time validator mode starts so that users
    // who do not read docs cannot later claim they were unaware the validator
    // consumes network / stake / CPU. See GH issue #451.
    try {
      console.log(
        '[Validator] Validator mode is ENABLED. Your node will participate in ' +
        'Hub validation tasks: CPU, network bandwidth, and staked credits WILL ' +
        'be used. To opt out, set EVOLVER_VALIDATOR_ENABLED=false (or unset it).'
      );
    } catch (_) { /* console unavailable -- non-fatal */ }
    // Fire preflight immediately so the user-visible warning lands before the
    // first DAEMON_FIRST_DELAY_MS tick. _ensurePreflight is idempotent and the
    // first call from runValidatorCycle will reuse this promise.
    _ensurePreflight();
  }
  _daemonTimer = setTimeout(_daemonTick, DAEMON_FIRST_DELAY_MS);
  return true;
}

function stopValidatorDaemon() {
  _daemonRunning = false;
  if (_daemonTimer) {
    clearTimeout(_daemonTimer);
    _daemonTimer = null;
  }
}

function getValidatorDaemonStats() {
  return Object.assign({ running: _daemonRunning, intervalMs: DAEMON_INTERVAL_MS }, _daemonStats);
}

function _resetPreflightForTests() {
  _preflightPromise = null;
  _preflightResult = null;
  _preflightDisabled = false;
  _daemonStats.preflight = null;
}

function _setPreflightForTests(result) {
  _preflightResult = result || { ok: true, durationMs: 0 };
  _preflightPromise = Promise.resolve(_preflightResult);
  _preflightDisabled = !_preflightResult.ok;
  _daemonStats.preflight = {
    ok: !!_preflightResult.ok,
    reason: _preflightResult.reason || null,
    duration_ms: _preflightResult.durationMs || 0,
    at: Date.now(),
  };
}

module.exports = {
  runValidatorCycle,
  fetchValidationTasks,
  validateOneTask,
  isValidatorEnabled,
  startValidatorDaemon,
  stopValidatorDaemon,
  getValidatorDaemonStats,
  _resetPreflightForTests,
  _setPreflightForTests,
};

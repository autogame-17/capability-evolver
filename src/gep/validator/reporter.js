// src/gep/validator/reporter.js
//
// Builds and submits validation reports for validation tasks.
// Sends via POST /a2a/report with `task_id` + `nonce` so the Hub routes the
// body into processValidationReport instead of the normal reporting path.
'use strict';

const crypto = require('crypto');
const { buildHubHeaders, getHubUrl, getNodeId } = require('../a2aProtocol');
const { captureEnvFingerprint } = require('../envFingerprint');
const { resolveHubUrl: resolveDefaultHubUrl } = require('../../config');

const REPORT_TIMEOUT_MS = Number(process.env.EVOLVER_VALIDATOR_REPORT_TIMEOUT_MS) || 10_000;

// Per-command stderr/stdout tail bundled into the report. Bounded so a noisy
// validator cannot blow up the Hub's a2a/report payload size.
const REPORT_CMD_TAIL_CHARS = 240;
const REPORT_MAX_COMMANDS = 8;

// Failure classes attached to each command result so the Hub can distinguish
// "validator host is broken" (env_fail) from "Gene's validation cmd cannot
// run in our hardened sandbox" (sandbox_block) from a real assertion failure
// (exit_nonzero).
const FAILURE_CLASS = {
  OK: 'ok',
  PARSE_FAILED: 'parse_failed',
  EXEC_NOT_ALLOWED: 'executable_not_allowed',
  SANDBOX_BLOCK_NODE_FLAG: 'sandbox_block_node_flag',
  SPAWN_FAILED: 'spawn_failed',
  TIMEOUT: 'timeout',
  EXIT_NONZERO: 'exit_nonzero',
  UNKNOWN: 'unknown',
};

function classifyCommandFailure(result) {
  if (!result) return FAILURE_CLASS.UNKNOWN;
  if (result.ok) return FAILURE_CLASS.OK;
  const stderr = String(result.stderr || '');
  if (result.timedOut) return FAILURE_CLASS.TIMEOUT;
  // Check sandbox-block-on-node-flag BEFORE the generic parse_failed check
  // because assertNodeCommandSafe wraps its rejection inside the
  // `command_parse_failed:` stderr prefix; a plain prefix check would
  // misclassify the Gene/Hub-incompatibility case as a parse error.
  if (stderr.includes('node flag not allowed in sandbox')
      || stderr.includes('node requires a script file argument')) {
    return FAILURE_CLASS.SANDBOX_BLOCK_NODE_FLAG;
  }
  if (stderr.startsWith('executable_not_allowed:')) return FAILURE_CLASS.EXEC_NOT_ALLOWED;
  if (stderr.startsWith('command_parse_failed:')) return FAILURE_CLASS.PARSE_FAILED;
  if (stderr.startsWith('spawn_failed:')) return FAILURE_CLASS.SPAWN_FAILED;
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
    return FAILURE_CLASS.EXIT_NONZERO;
  }
  return FAILURE_CLASS.UNKNOWN;
}

function tailString(s, n) {
  const str = typeof s === 'string' ? s : '';
  if (str.length <= n) return str;
  return str.slice(-n);
}

function summarizeResult(result) {
  return {
    cmd: typeof result.cmd === 'string' ? result.cmd.slice(0, 200) : '',
    ok: !!result.ok,
    exit_code: typeof result.exitCode === 'number' ? result.exitCode : null,
    duration_ms: typeof result.durationMs === 'number' ? result.durationMs : 0,
    timed_out: !!result.timedOut,
    failure_class: classifyCommandFailure(result),
    stderr_tail: tailString(result.stderr, REPORT_CMD_TAIL_CHARS),
  };
}

// Aggregate failure_class for the whole report -- the first non-OK class wins.
// Surfaces a single label in `failure_class` at the top of the report so that
// the Hub can route on it without iterating per-command.
function aggregateFailureClass(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return FAILURE_CLASS.UNKNOWN;
  if (commands.every((c) => c.failure_class === FAILURE_CLASS.OK)) return FAILURE_CLASS.OK;
  for (const c of commands) {
    if (c.failure_class && c.failure_class !== FAILURE_CLASS.OK) return c.failure_class;
  }
  return FAILURE_CLASS.UNKNOWN;
}

function resolveHubUrl() {
  try {
    const u = getHubUrl && getHubUrl();
    if (u && typeof u === 'string') return u;
  } catch (_) {}
  return resolveDefaultHubUrl();
}

function hashExecutionLog(results) {
  const list = Array.isArray(results) ? results : [];
  const hash = crypto.createHash('sha256');
  for (const r of list) {
    hash.update(String(r.cmd || ''));
    hash.update('\0');
    hash.update(String(r.ok ? 1 : 0));
    hash.update('\0');
    hash.update(String(r.exitCode || 0));
    hash.update('\0');
    hash.update((r.stdout || '').slice(0, 4000));
    hash.update('\0');
    hash.update((r.stderr || '').slice(0, 4000));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Build the validation report payload the Hub expects.
 *
 * @param {{ task_id: string, nonce: string }} task
 * @param {{ results: Array, overallOk: boolean, durationMs: number }} execution
 * @param {{ reproductionScore?: number }} [opts]
 */
function buildReportPayload(task, execution, opts) {
  const options = opts || {};
  const results = Array.isArray(execution && execution.results) ? execution.results : [];
  const commandsTotal = results.length;
  const commandsPassed = results.filter((r) => r && r.ok).length;
  const env = captureEnvFingerprint();

  const reproductionScore = Number.isFinite(options.reproductionScore)
    ? options.reproductionScore
    : (commandsTotal > 0 ? commandsPassed / commandsTotal : 0);

  // Per-command summaries. Bounded to REPORT_MAX_COMMANDS so a runaway batch
  // cannot blow up the Hub payload size.
  const commands = results.slice(0, REPORT_MAX_COMMANDS).map(summarizeResult);
  const failureClass = !execution.overallOk
    ? aggregateFailureClass(commands)
    : FAILURE_CLASS.OK;

  return {
    task_id: task.task_id,
    nonce: task.nonce,
    overall_ok: !!execution.overallOk,
    commands_passed: commandsPassed,
    commands_total: commandsTotal,
    duration_ms: execution.durationMs || 0,
    execution_log_hash: hashExecutionLog(results),
    env_fingerprint: env,
    reproduction_score: Math.max(0, Math.min(1, reproductionScore)),
    // New diagnostic surface (Hub-side classifier should prefer these when
    // present; older Hubs that ignore unknown fields keep working unchanged).
    failure_class: failureClass,
    commands,
  };
}

async function submitReport(payload) {
  const nodeId = getNodeId();
  if (!nodeId) return { ok: false, error: 'no_node_id' };
  const hubUrl = resolveHubUrl();
  const url = hubUrl.replace(/\/+$/, '') + '/a2a/report';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

  const msg = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: 'report',
    message_id: 'msg_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    sender_id: nodeId,
    timestamp: new Date().toISOString(),
    payload,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHubHeaders(),
      body: JSON.stringify(msg),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 400) };
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  buildReportPayload,
  submitReport,
  hashExecutionLog,
  classifyCommandFailure,
  aggregateFailureClass,
  FAILURE_CLASS,
};

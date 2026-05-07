// test/validatorReportDiagnostics.test.js
//
// Coverage for the diagnostic surface added to ValidationReport (failure_class
// + per-command summaries) and the validator-host preflight gate. Both
// changes are aimed at fixing an env_fail flood where the Hub could not tell
// apart:
//   - "validator host has no `node` binary"   (genuine env_fail)
//   - "Gene shipped legacy `node -e` cmd"     (Hub/Gene incompatibility)
//   - "real assertion failed"                  (genuine fail)
// because every failure surfaced as `commands_passed=0, duration_ms=1`.
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sandbox = require('../src/gep/validator/sandboxExecutor');
const reporter = require('../src/gep/validator/reporter');
const validatorIndex = require('../src/gep/validator');

const FX_DIR = path.join(__dirname, 'fixtures');
const CMD_PASS = 'node ' + path.join(FX_DIR, 'pass.js');

function mkRes({ status = 200, body = {}, ok = true } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

function withFakeFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original; });
}

describe('reporter.classifyCommandFailure', function () {
  it('returns ok for a successful command', function () {
    assert.equal(reporter.classifyCommandFailure({ ok: true }), reporter.FAILURE_CLASS.OK);
  });

  it('classifies node -e style sandbox blocks separately from spawn failures', function () {
    const r = {
      ok: false,
      stderr: 'command_parse_failed: node flag not allowed in sandbox: -e',
    };
    assert.equal(
      reporter.classifyCommandFailure(r),
      reporter.FAILURE_CLASS.SANDBOX_BLOCK_NODE_FLAG,
    );
  });

  it('classifies inline-eval-without-script as sandbox_block_node_flag', function () {
    const r = {
      ok: false,
      stderr: 'command_parse_failed: node requires a script file argument in sandbox',
    };
    assert.equal(
      reporter.classifyCommandFailure(r),
      reporter.FAILURE_CLASS.SANDBOX_BLOCK_NODE_FLAG,
    );
  });

  it('classifies spawn_failed prefix from sandboxExecutor', function () {
    assert.equal(
      reporter.classifyCommandFailure({ ok: false, stderr: 'spawn_failed: ENOENT' }),
      reporter.FAILURE_CLASS.SPAWN_FAILED,
    );
  });

  it('classifies executable_not_allowed when bash/python is rejected', function () {
    assert.equal(
      reporter.classifyCommandFailure({ ok: false, stderr: 'executable_not_allowed: bash (allowed: node)' }),
      reporter.FAILURE_CLASS.EXEC_NOT_ALLOWED,
    );
  });

  it('classifies timed-out commands', function () {
    assert.equal(
      reporter.classifyCommandFailure({ ok: false, timedOut: true, stderr: '' }),
      reporter.FAILURE_CLASS.TIMEOUT,
    );
  });

  it('classifies non-zero exit when the assertion script genuinely failed', function () {
    assert.equal(
      reporter.classifyCommandFailure({ ok: false, exitCode: 1, stderr: 'AssertionError' }),
      reporter.FAILURE_CLASS.EXIT_NONZERO,
    );
  });

  it('returns command_parse_failed for shell metacharacter rejections', function () {
    assert.equal(
      reporter.classifyCommandFailure({
        ok: false,
        stderr: 'command_parse_failed: shell metacharacter not allowed in command: |',
      }),
      reporter.FAILURE_CLASS.PARSE_FAILED,
    );
  });
});

describe('reporter.buildReportPayload diagnostic surface', function () {
  it('attaches per-command summaries with failure_class + stderr_tail', function () {
    const payload = reporter.buildReportPayload(
      { task_id: 'vt_1', nonce: 'n_1' },
      {
        results: [
          { cmd: 'node validate.js', ok: true, exitCode: 0, durationMs: 12, stdout: 'ok', stderr: '' },
          {
            cmd: 'node -e "x"',
            ok: false,
            exitCode: -1,
            durationMs: 0,
            stdout: '',
            stderr: 'command_parse_failed: node flag not allowed in sandbox: -e',
            timedOut: false,
          },
        ],
        overallOk: false,
        durationMs: 15,
      },
    );
    assert.ok(Array.isArray(payload.commands));
    assert.equal(payload.commands.length, 2);
    assert.equal(payload.commands[0].failure_class, 'ok');
    assert.equal(payload.commands[1].failure_class, 'sandbox_block_node_flag');
    assert.match(payload.commands[1].stderr_tail || '', /node flag not allowed/);
    assert.equal(typeof payload.commands[1].duration_ms, 'number');
  });

  it('aggregates failure_class to the first non-ok command', function () {
    const payload = reporter.buildReportPayload(
      { task_id: 't', nonce: 'n' },
      {
        results: [
          { cmd: 'a', ok: true, exitCode: 0, durationMs: 1 },
          { cmd: 'b', ok: false, exitCode: 1, durationMs: 1, stderr: 'AssertionError' },
        ],
        overallOk: false,
        durationMs: 2,
      },
    );
    assert.equal(payload.failure_class, 'exit_nonzero');
  });

  it('returns failure_class=ok when overall passes', function () {
    const payload = reporter.buildReportPayload(
      { task_id: 't', nonce: 'n' },
      { results: [{ cmd: 'a', ok: true, exitCode: 0, durationMs: 1 }], overallOk: true, durationMs: 1 },
    );
    assert.equal(payload.failure_class, 'ok');
    assert.equal(payload.commands.length, 1);
  });

  it('truncates stderr_tail to ~240 chars to keep payload small', function () {
    const longStderr = 'X'.repeat(2000);
    const payload = reporter.buildReportPayload(
      { task_id: 't', nonce: 'n' },
      {
        results: [{ cmd: 'a', ok: false, exitCode: 1, durationMs: 1, stderr: longStderr }],
        overallOk: false,
        durationMs: 1,
      },
    );
    assert.ok(payload.commands[0].stderr_tail.length <= 240);
    assert.equal(payload.commands[0].stderr_tail.slice(-1), 'X');
  });

  it('caps commands array to 8 entries even on very long batches', function () {
    const results = Array.from({ length: 20 }, (_, i) => ({
      cmd: 'cmd ' + i, ok: true, exitCode: 0, durationMs: 1, stdout: '', stderr: '',
    }));
    const payload = reporter.buildReportPayload(
      { task_id: 't', nonce: 'n' },
      { results, overallOk: true, durationMs: 20 },
    );
    assert.equal(payload.commands.length, 8);
    assert.equal(payload.commands_total, 20);
  });
});

describe('sandboxExecutor.runPreflight', function () {
  it('passes on a host where `node <script>` works', async function () {
    const out = await sandbox.runPreflight();
    assert.equal(out.ok, true, 'preflight should pass when node binary is on PATH');
    assert.equal(typeof out.durationMs, 'number');
    assert.equal(typeof out.exitCode, 'number');
    assert.equal(out.exitCode, 0);
  });
});

describe('validator.runValidatorCycle preflight gate', function () {
  const originalEnv = { ...process.env };
  let tmpHome;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-preflight-'));
    process.env.EVOLVER_HOME = tmpHome;
    process.env.A2A_HUB_URL = 'http://hub.local';
    process.env.HUB_NODE_SECRET = 'secret';
    process.env.A2A_NODE_ID = 'node_test_validator_pf';
    try {
      const sb = require('../src/gep/validator/stakeBootstrap');
      if (sb && typeof sb._resetStateForTests === 'function') sb._resetStateForTests();
    } catch (_) {}
    validatorIndex._resetPreflightForTests();
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
    if (tmpHome) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
    }
    validatorIndex._resetPreflightForTests();
  });

  it('returns skipped:"preflight_failed" without contacting Hub when preflight fails', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    validatorIndex._setPreflightForTests({
      ok: false,
      reason: 'preflight_exit_nonzero',
      durationMs: 5,
      stderrTail: 'node: not found',
    });
    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; return mkRes({ ok: false, status: 599 }); };
    const out = await withFakeFetch(fetchImpl, () => validatorIndex.runValidatorCycle({}));
    assert.equal(out.skipped, 'preflight_failed');
    assert.equal(out.reason, 'preflight_exit_nonzero');
    assert.equal(fetched, 0, 'no Hub call should be issued when preflight failed');
  });

  it('proceeds normally when preflight is forced ok', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    validatorIndex._setPreflightForTests({ ok: true, durationMs: 30, exitCode: 0 });
    const fetchImpl = async (url) => {
      if (url.endsWith('/a2a/validator/stake')) return mkRes({ body: { stake: { stake_amount: 100 } } });
      if (url.endsWith('/a2a/fetch')) {
        return mkRes({
          body: {
            validation_tasks: [
              { task_id: 'vt_pf_ok', nonce: 'n', validation_commands: [CMD_PASS] },
            ],
          },
        });
      }
      if (url.endsWith('/a2a/report')) return mkRes({ body: { status: 'accepted' } });
      return mkRes({ ok: false });
    };
    const out = await withFakeFetch(fetchImpl, () => validatorIndex.runValidatorCycle({}));
    assert.equal(out.processed, 1);
    assert.equal(out.outcomes[0].report.overall_ok, true);
    assert.equal(out.outcomes[0].report.failure_class, 'ok');
  });
});

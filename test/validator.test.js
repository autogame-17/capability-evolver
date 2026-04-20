// test/validator.test.js
// Tests for the opt-in validator role: sandbox executor, reporter, and
// the cycle orchestrator. All tests stay in-process (no real Hub calls)
// by monkey-patching global fetch for report/stake submissions.
'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const sandbox = require('../src/gep/validator/sandboxExecutor');
const reporter = require('../src/gep/validator/reporter');
const validatorIndex = require('../src/gep/validator');

function withFakeFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = original; });
}

function mkRes({ status = 200, body = {}, ok = true } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

describe('sandboxExecutor.runInSandbox', function () {
  const isWin = process.platform === 'win32';

  it('runs a passing command inside an isolated temp dir', async function () {
    const cmd = 'node -e "process.stdout.write(\'hello-sandbox\\n\' + process.cwd() + \'\\n\')"';
    const out = await sandbox.runInSandbox([cmd], {});
    assert.equal(out.results.length, 1);
    assert.equal(out.overallOk, true);
    assert.match(out.results[0].stdout, /hello-sandbox/);
    // cwd must not be evolver workspace; should be under /tmp (or OS tmpdir)
    const tmpRoot = require('os').tmpdir();
    assert.match(out.results[0].stdout, new RegExp(tmpRoot.replace(/\\/g, '\\\\')));
  });

  it('stops at first failure and reports overallOk=false', async function () {
    const out = await sandbox.runInSandbox([
      'node -e "process.stdout.write(\'first\\n\')"',
      'node -e "process.exit(2)"',
      'node -e "process.stdout.write(\'should-not-run\\n\')"',
    ], {});
    assert.equal(out.overallOk, false);
    assert.equal(out.stoppedEarly, true);
    // Only the first two commands ran.
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[1].ok, false);
  });

  it('enforces per-command timeout (kills long-running commands)', async function () {
    const longCmd = 'node -e "setTimeout(()=>{},9999)"';
    const out = await sandbox.runInSandbox([longCmd], { cmdTimeoutMs: 300 });
    assert.equal(out.overallOk, false);
    assert.equal(out.results[0].timedOut, true);
  });

  it('cleans up sandbox directory after execution', async function () {
    const cmd = 'node -e "process.exit(0)"';
    let captured;
    const out = await sandbox.runInSandbox([cmd], { keepSandbox: true });
    captured = out.sandboxDir;
    assert.ok(captured);
    assert.ok(fs.existsSync(captured));
    // Now call with cleanup (default).
    const out2 = await sandbox.runInSandbox([cmd], {});
    assert.equal(out2.sandboxDir, null);
    sandbox.cleanupDir(captured);
  });

  it('returns reason=no_commands for empty array', async function () {
    const out = await sandbox.runInSandbox([], {});
    assert.equal(out.reason, 'no_commands');
    assert.equal(out.overallOk, false);
  });
});

describe('reporter.buildReportPayload', function () {
  it('produces Hub-compatible payload with task_id/nonce', function () {
    const task = { task_id: 'vt_123', nonce: 'n_abc' };
    const execution = {
      results: [
        { cmd: 'echo a', ok: true, stdout: 'a', stderr: '', exitCode: 0, durationMs: 10 },
        { cmd: 'echo b', ok: true, stdout: 'b', stderr: '', exitCode: 0, durationMs: 5 },
      ],
      overallOk: true,
      durationMs: 15,
    };
    const payload = reporter.buildReportPayload(task, execution);
    assert.equal(payload.task_id, 'vt_123');
    assert.equal(payload.nonce, 'n_abc');
    assert.equal(payload.overall_ok, true);
    assert.equal(payload.commands_total, 2);
    assert.equal(payload.commands_passed, 2);
    assert.equal(payload.reproduction_score, 1);
    assert.equal(typeof payload.execution_log_hash, 'string');
    assert.equal(payload.execution_log_hash.length, 64);
    assert.ok(payload.env_fingerprint && typeof payload.env_fingerprint === 'object');
  });

  it('hashes execution log deterministically', function () {
    const results = [
      { cmd: 'echo a', ok: true, exitCode: 0, stdout: 'a', stderr: '' },
    ];
    const h1 = reporter.hashExecutionLog(results);
    const h2 = reporter.hashExecutionLog(results);
    assert.equal(h1, h2);
    const h3 = reporter.hashExecutionLog([{ ...results[0], stdout: 'b' }]);
    assert.notEqual(h1, h3);
  });

  it('reproductionScore reflects partial passes', function () {
    const payload = reporter.buildReportPayload(
      { task_id: 't', nonce: 'n' },
      {
        results: [
          { cmd: 'a', ok: true, exitCode: 0 },
          { cmd: 'b', ok: false, exitCode: 1 },
        ],
        overallOk: false,
        durationMs: 10,
      },
    );
    assert.equal(payload.reproduction_score, 0.5);
  });
});

describe('validator.runValidatorCycle', function () {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.A2A_HUB_URL = 'http://hub.local';
    process.env.HUB_NODE_SECRET = 'secret';
    process.env.A2A_NODE_ID = 'node_test_validator';
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns skipped:"disabled" when EVOLVER_VALIDATOR_ENABLED=0', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '0';
    const out = await validatorIndex.runValidatorCycle({});
    assert.equal(out.skipped, 'disabled');
  });

  it('fetches, sandboxes, and reports when enabled; reports overall_ok=false on failure', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (url.endsWith('/a2a/validator/stake')) {
        return mkRes({ body: { stake: { stake_amount: 100 } } });
      }
      if (url.endsWith('/a2a/fetch')) {
        return mkRes({
          body: {
            validation_tasks: [
              {
                task_id: 'vt_fail',
                nonce: 'nonce_abc',
                asset_id: 'asset_x',
                validation_commands: ['node -e "process.stdout.write(\'ok\\n\')"', 'node -e "process.exit(1)"'],
                expires_at: new Date(Date.now() + 60000).toISOString(),
              },
            ],
          },
        });
      }
      if (url.endsWith('/a2a/report')) {
        return mkRes({ body: { status: 'accepted', payload: body.payload } });
      }
      return mkRes({ ok: false, status: 404, body: { error: 'not_found' } });
    };
    const out = await withFakeFetch(fetchImpl, () => validatorIndex.runValidatorCycle({}));
    assert.equal(out.processed, 1);
    assert.equal(out.outcomes[0].status, 'reported');
    assert.equal(out.outcomes[0].report.overall_ok, false);
    assert.equal(out.outcomes[0].report.commands_total, 2);
    assert.equal(out.outcomes[0].report.commands_passed, 1);
    // Ensure stake was attempted once.
    const stakeCalls = calls.filter((c) => c.url.endsWith('/a2a/validator/stake'));
    assert.equal(stakeCalls.length, 1);
  });

  it('reports passing result when all commands succeed', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    const fetchImpl = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (url.endsWith('/a2a/validator/stake')) {
        return mkRes({ body: { stake: { stake_amount: 100 } } });
      }
      if (url.endsWith('/a2a/fetch')) {
        return mkRes({
          body: {
            validation_tasks: [
              {
                task_id: 'vt_ok',
                nonce: 'nonce_xyz',
                validation_commands: ['node -e "process.stdout.write(\'alpha\\n\')"', 'node -e "process.stdout.write(\'beta\\n\')"'],
              },
            ],
          },
        });
      }
      if (url.endsWith('/a2a/report')) {
        return mkRes({ body: { status: 'accepted', payload: body.payload } });
      }
      return mkRes({ ok: false, status: 404, body: {} });
    };
    const out = await withFakeFetch(fetchImpl, () => validatorIndex.runValidatorCycle({}));
    assert.equal(out.outcomes[0].report.overall_ok, true);
    assert.equal(out.outcomes[0].report.commands_passed, 2);
  });

  it('gracefully handles empty validation_tasks list', async function () {
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    const fetchImpl = async (url) => {
      if (url.endsWith('/a2a/validator/stake')) return mkRes({ body: {} });
      if (url.endsWith('/a2a/fetch')) return mkRes({ body: { validation_tasks: [] } });
      return mkRes({ ok: false });
    };
    const out = await withFakeFetch(fetchImpl, () => validatorIndex.runValidatorCycle({}));
    assert.equal(out.tasks, 0);
    assert.equal(out.processed, 0);
  });
});

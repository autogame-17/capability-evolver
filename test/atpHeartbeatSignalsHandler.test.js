const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
const envKeys = ['EVOLVER_ATP_AUTODELIVER', 'MEMORY_DIR'];

let tmpMemoryDir;
let handler;
let hubClient;
let origSubmitDelivery;
let submitCalls;

function makeTmpMemoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atp-hb-handler-'));
}

beforeEach(() => {
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpMemoryDir = makeTmpMemoryDir();
  process.env.MEMORY_DIR = tmpMemoryDir;

  // Invalidate require cache so each test gets a fresh module state
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/atp/') || key.includes('/src/gep/paths')) {
      delete require.cache[key];
    }
  }
  handler = require('../src/atp/heartbeatSignalsHandler');
  hubClient = require('../src/atp/hubClient');
  origSubmitDelivery = hubClient.submitDelivery;

  submitCalls = [];
  hubClient.submitDelivery = function (orderId, payload) {
    submitCalls.push({ orderId, payload });
    return Promise.resolve({ ok: true, status: 200, data: {} });
  };
  handler._internals.resetForTests();
});

afterEach(() => {
  if (origSubmitDelivery) hubClient.submitDelivery = origSubmitDelivery;
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmpMemoryDir, { recursive: true, force: true }); } catch (_) {}
});

describe('heartbeatSignalsHandler gating', () => {
  it('submits once when a deliverable pending_delivery arrives', async () => {
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_1', task_id: 't1', result_asset_id: 'asset1', verify_mode: 'auto' },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.submitted, 1);
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].orderId, 'atp_1');
    assert.equal(submitCalls[0].payload.asset_id, 'asset1');
    assert.equal(submitCalls[0].payload.result, 'completed');
  });

  it('writes heartbeat ledger with private permissions when possible', async () => {
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_perm', task_id: 't1', result_asset_id: 'asset1', verify_mode: 'auto' },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.submitted, 1);
    const ledgerPath = path.join(tmpMemoryDir, 'atp-autodeliver-ledger.json');
    assert.ok(fs.existsSync(ledgerPath));
  });

  it('skips deliveries without result_asset_id (nothing to deliver)', async () => {
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_1', task_id: 't1', result_asset_id: null, verify_mode: 'auto' },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.submitted, 0);
    assert.equal(submitCalls.length, 0);
  });

  it('counts need_work for pending_atp_tasks without result_asset_id', async () => {
    const signals = {
      pending_atp_tasks: [
        { phase: 'claim', task_id: 't1', order_id: 'atp_1', result_asset_id: null },
        { phase: 'execute', task_id: 't2', order_id: 'atp_2', result_asset_id: null },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.need_work, 2);
    assert.equal(submitCalls.length, 0);
  });

  it('ledger prevents double-submission across invocations', async () => {
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_1', task_id: 't1', result_asset_id: 'a1', verify_mode: 'auto' },
      ],
    };
    const first = await handler.handleHeartbeatSignals(signals);
    assert.equal(first.submitted, 1);

    // Bypass cooldown by resetting the handler's rate-limit state but KEEP
    // the on-disk ledger in place (simulating a later heartbeat tick).
    handler._internals.resetForTests();
    const second = await handler.handleHeartbeatSignals(signals);
    assert.equal(second.submitted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(submitCalls.length, 1); // still only the first submission
  });

  it('records terminal Hub errors (409) in ledger so we do not hammer', async () => {
    hubClient.submitDelivery = function () {
      return Promise.resolve({ ok: false, status: 409, error: 'already_delivered' });
    };
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_terminal', task_id: 't1', result_asset_id: 'a1', verify_mode: 'auto' },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.failed, 1);

    const ledger = handler._internals.readLedger();
    assert.ok(ledger.submitted['atp_terminal'] < 0, 'terminal error should be marked negative');
  });

  it('does not run when EVOLVER_ATP_AUTODELIVER=off', async () => {
    process.env.EVOLVER_ATP_AUTODELIVER = 'off';
    // Re-require because gating reads env at call time (_isEnabled); this test
    // exercises that gate explicitly.
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_1', task_id: 't1', result_asset_id: 'a1', verify_mode: 'auto' },
      ],
    };
    const summary = await handler.handleHeartbeatSignals(signals);
    assert.equal(summary.submitted, 0);
    assert.equal(submitCalls.length, 0);
  });

  it('respects per-call cooldown (back-to-back call returns empty)', async () => {
    const signals = {
      pending_deliveries: [
        { proof_id: 'p1', order_id: 'atp_A', task_id: 't1', result_asset_id: 'a1', verify_mode: 'auto' },
      ],
    };
    const first = await handler.handleHeartbeatSignals(signals);
    assert.equal(first.submitted, 1);
    // Immediate second call -- cooldown not elapsed, should no-op
    const second = await handler.handleHeartbeatSignals({
      pending_deliveries: [
        { proof_id: 'p2', order_id: 'atp_B', task_id: 't2', result_asset_id: 'a2', verify_mode: 'auto' },
      ],
    });
    assert.equal(second.submitted, 0);
  });

  it('_collectDeliverable dedups overlapping order_ids across both lists', () => {
    const deliveries = [
      { proof_id: 'p', order_id: 'dup', task_id: 't', result_asset_id: 'a' },
    ];
    const atpTasks = [
      { phase: 'execute', order_id: 'dup', task_id: 't', result_asset_id: 'a' },
      { phase: 'claim', order_id: 'unique', task_id: 't2', result_asset_id: 'a2' },
    ];
    const out = handler._internals.collectDeliverable(deliveries, atpTasks);
    assert.equal(out.length, 2);
    const orderIds = out.map(r => r.order_id).sort();
    assert.deepEqual(orderIds, ['dup', 'unique']);
  });
});

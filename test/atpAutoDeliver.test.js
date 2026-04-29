const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
const envKeys = ['EVOLVER_ATP_AUTODELIVER', 'ATP_AUTODELIVER_POLL_MS', 'MEMORY_DIR'];

let tmpMemoryDir;
let autoDeliver;
let hubClient;
let origListMyTasks;
let origSubmitDelivery;

function makeTmpMemoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atp-autodeliver-'));
}

beforeEach(() => {
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpMemoryDir = makeTmpMemoryDir();
  process.env.MEMORY_DIR = tmpMemoryDir;

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/atp/') || key.includes('/src/gep/paths')) {
      delete require.cache[key];
    }
  }
  autoDeliver = require('../src/atp/autoDeliver');
  hubClient = require('../src/atp/hubClient');
  origListMyTasks = hubClient.listMyTasks;
  origSubmitDelivery = hubClient.submitDelivery;
  autoDeliver.__internals.resetForTests();
});

afterEach(() => {
  if (origListMyTasks) hubClient.listMyTasks = origListMyTasks;
  if (origSubmitDelivery) hubClient.submitDelivery = origSubmitDelivery;
  autoDeliver.stop();
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmpMemoryDir, { recursive: true, force: true }); } catch (_) {}
});

describe('autoDeliver.start gating', () => {
  it('starts when EVOLVER_ATP_AUTODELIVER is unset (default on)', () => {
    autoDeliver.start({ pollMs: 20000 });
    assert.equal(autoDeliver.isStarted(), true);
  });

  it('does not start when EVOLVER_ATP_AUTODELIVER=off', () => {
    process.env.EVOLVER_ATP_AUTODELIVER = 'off';
    autoDeliver.start({ pollMs: 20000 });
    assert.equal(autoDeliver.isStarted(), false);
  });

  it('start is idempotent', () => {
    autoDeliver.start({ pollMs: 20000 });
    autoDeliver.start({ pollMs: 99999 });
    assert.equal(autoDeliver.isStarted(), true);
  });
});

describe('autoDeliver tick behavior', () => {
  it('calls submitDelivery exactly once per completed ATP task and records in ledger', async () => {
    hubClient.listMyTasks = async () => ({
      ok: true,
      data: {
        tasks: [
          { question_id: 'q1', atp_order_id: 'ord_1', result_asset_id: 'asset_1', status: 'claimed' },
          { question_id: 'q2', atp_order_id: 'ord_2', result_asset_id: 'asset_2', status: 'claimed' },
        ],
      },
    });
    const delivered = [];
    hubClient.submitDelivery = async (orderId, payload) => {
      delivered.push({ orderId, payload });
      return { ok: true, data: { order_id: orderId, status: 'verified' } };
    };

    await autoDeliver.__internals.tick();
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].orderId, 'ord_1');
    assert.equal(delivered[0].payload.result, 'completed');
    assert.equal(delivered[0].payload.asset_id, 'asset_1');

    // Second tick should be a no-op for the same orders (dedup).
    await autoDeliver.__internals.tick();
    assert.equal(delivered.length, 2, 'already-delivered orders must not be re-submitted');
  });

  it('skips tasks without atp_order_id', async () => {
    hubClient.listMyTasks = async () => ({
      ok: true,
      data: {
        tasks: [
          { question_id: 'q1', result_asset_id: 'asset_1', status: 'claimed' },
        ],
      },
    });
    let called = 0;
    hubClient.submitDelivery = async () => { called += 1; return { ok: true }; };
    await autoDeliver.__internals.tick();
    assert.equal(called, 0);
  });

  it('skips tasks without result_asset_id (solidify not finished)', async () => {
    hubClient.listMyTasks = async () => ({
      ok: true,
      data: {
        tasks: [
          { question_id: 'q1', atp_order_id: 'ord_x', status: 'claimed' },
        ],
      },
    });
    let called = 0;
    hubClient.submitDelivery = async () => { called += 1; return { ok: true }; };
    await autoDeliver.__internals.tick();
    assert.equal(called, 0);
  });

  it('marks terminal hub errors (400/404/409) in ledger so we do not retry', async () => {
    hubClient.listMyTasks = async () => ({
      ok: true,
      data: {
        tasks: [
          { question_id: 'q1', atp_order_id: 'ord_bad', result_asset_id: 'asset_1', status: 'claimed' },
        ],
      },
    });
    let called = 0;
    hubClient.submitDelivery = async () => { called += 1; return { ok: false, status: 400, error: 'bad_payload' }; };
    await autoDeliver.__internals.tick();
    await autoDeliver.__internals.tick();
    assert.equal(called, 1);
  });

  it('retries transient errors (no status / 5xx) on next tick', async () => {
    hubClient.listMyTasks = async () => ({
      ok: true,
      data: {
        tasks: [
          { question_id: 'q1', atp_order_id: 'ord_retry', result_asset_id: 'asset_1', status: 'claimed' },
        ],
      },
    });
    let called = 0;
    hubClient.submitDelivery = async () => { called += 1; return { ok: false, error: 'network_timeout' }; };
    await autoDeliver.__internals.tick();
    await autoDeliver.__internals.tick();
    assert.equal(called, 2);
  });

  it('survives a hub listMyTasks failure without throwing', async () => {
    hubClient.listMyTasks = async () => ({ ok: false, error: 'hub_down' });
    await autoDeliver.__internals.tick();
    assert.equal(autoDeliver.isStarted(), false);
  });
});

describe('autoDeliver.buildProofPayload', () => {
  it('emits a minimal payload with result=completed', () => {
    const p = autoDeliver.__internals.buildProofPayload({
      result_asset_id: 'asset_xyz',
      claimed_at: '2026-04-27T00:00:00.000Z',
      signals: ['s1', 'token=abcdefghijklmnop1234567890', 'path:/home/alice/private'],
    });
    assert.equal(p.result, 'completed');
    assert.equal(p.asset_id, 'asset_xyz');
    assert.equal(p.pass_rate, 1.0);
    assert.equal(p.submitter, 'evolver_auto_deliver');
    assert.equal(p.signals[0], 's1');
    assert.ok(p.signals[1].includes('[REDACTED]'));
    assert.ok(p.signals[2].includes('[REDACTED]'));
  });
});

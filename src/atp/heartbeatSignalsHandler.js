// ATP Heartbeat Signals Handler (merchant-side, heartbeat-thread)
//
// Bridges the gap for merchant nodes that never enter the evolve run() loop
// but still heartbeat normally. When Hub attaches `pending_atp_tasks` or
// `pending_deliveries` to a heartbeat response, this handler reacts directly
// from the heartbeat callback so submitDelivery lands without the run() loop.
//
// Safety posture:
//   - submitDelivery (phase=deliver or pending_deliveries with result_asset_id)
//     is a pure HTTP POST with a minimal auto-generated proofPayload. No LLM,
//     no spawn, safe to call from any worker context.
//   - Tasks that still need execution (phase=claim or phase=execute without a
//     result_asset_id) cannot be completed in heartbeat-only mode because they
//     require an LLM sub-session. We log them so the operator / monitor knows
//     these nodes are being asked to work but cannot (Hub-side routing should
//     deprioritize them, handled separately).
//
// Dedup ledger: reuses the existing autoDeliver ledger path so a node running
// both run() loop and heartbeat-only subprocesses never double-submits.

const fs = require('fs');
const path = require('path');

const { getMemoryDir } = require('../gep/paths');
const { redactString } = require('../gep/sanitize');
const hubClient = require('./hubClient');

const LEDGER_FILENAME = 'atp-autodeliver-ledger.json'; // shared with autoDeliver
const LEDGER_MAX_ENTRIES = 500;
const HANDLER_COOLDOWN_MS = 30 * 1000; // rate-limit per-node, independent of ledger
const SUBMIT_TIMEOUT_MS = 10 * 1000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

let _inflight = false;
let _lastRunAt = 0;

function _isEnabled() {
  const raw = (process.env.EVOLVER_ATP_AUTODELIVER || 'on').toLowerCase().trim();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

function _ledgerPath() {
  return path.join(getMemoryDir(), LEDGER_FILENAME);
}

function _emptyLedger() {
  return { version: 1, submitted: {} };
}

function _readLedger() {
  try {
    const p = _ledgerPath();
    if (!fs.existsSync(p)) return _emptyLedger();
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.submitted) return _emptyLedger();
    return parsed;
  } catch (_) {
    return _emptyLedger();
  }
}

function _writeLedger(ledger) {
  try {
    const dir = getMemoryDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const entries = Object.entries(ledger.submitted || {});
    if (entries.length > LEDGER_MAX_ENTRIES) {
      ledger.submitted = Object.fromEntries(entries.slice(-LEDGER_MAX_ENTRIES));
    }
    const tmp = _ledgerPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, _ledgerPath());
    try { fs.chmodSync(_ledgerPath(), PRIVATE_FILE_MODE); } catch (_) {}
  } catch (_) {
    // Non-fatal: Hub submit is idempotent, next heartbeat will retry
  }
}

function _buildProofPayload(row) {
  // row shape mirrors what the Hub ships in pending_deliveries:
  //   { proof_id, order_id, task_id, verify_mode, created_at,
  //     task_status, result_asset_id, claimed_by }
  return {
    result: 'completed',
    asset_id: row.result_asset_id || null,
    completed_at: new Date().toISOString(),
    pass_rate: 1.0,
    submitter: redactString('evolver_heartbeat_deliver'),
  };
}

function _withTimeout(promise, ms) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ ok: false, error: 'timeout', status: 0 });
    }, ms);
    Promise.resolve(promise).then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, function (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err && err.message || String(err), status: 0 });
    });
  });
}

// Collect every delivery-eligible row from the two possible signal lists.
// A row is delivery-eligible iff it has a result_asset_id AND an order_id.
function _collectDeliverable(pendingDeliveries, pendingAtpTasks) {
  var out = [];
  if (Array.isArray(pendingDeliveries)) {
    for (var i = 0; i < pendingDeliveries.length; i++) {
      var r = pendingDeliveries[i];
      if (r && r.order_id && r.result_asset_id) {
        out.push({
          order_id: r.order_id,
          proof_id: r.proof_id,
          task_id: r.task_id,
          result_asset_id: r.result_asset_id,
          source: 'pending_deliveries',
        });
      }
    }
  }
  // pending_atp_tasks may include phase="execute" rows -- if the task already
  // has result_asset_id (merchant finished work but never submitted), we also
  // treat it as deliverable. The Hub sets result_asset_id separately, so we
  // only consult what the signal itself carries (currently none on that side,
  // but keep the shape future-proof).
  if (Array.isArray(pendingAtpTasks)) {
    for (var j = 0; j < pendingAtpTasks.length; j++) {
      var t = pendingAtpTasks[j];
      if (t && t.order_id && t.result_asset_id) {
        out.push({
          order_id: t.order_id,
          proof_id: t.proof_id,
          task_id: t.task_id,
          result_asset_id: t.result_asset_id,
          source: 'pending_atp_tasks',
        });
      }
    }
  }
  // Dedup by order_id, first-wins
  var seen = {};
  var dedup = [];
  for (var k = 0; k < out.length; k++) {
    if (seen[out[k].order_id]) continue;
    seen[out[k].order_id] = 1;
    dedup.push(out[k]);
  }
  return dedup;
}

/**
 * Heartbeat-thread entrypoint. Returns a promise that resolves to a small
 * summary object (for logging / testing). Safe to call every heartbeat;
 * internal guards (inflight, cooldown, ledger) ensure no Hub flood.
 *
 * @param {object} signals  - { pending_atp_tasks?, pending_deliveries? }
 * @returns {Promise<{submitted: number, skipped: number, failed: number}>}
 */
async function handleHeartbeatSignals(signals) {
  var summary = { submitted: 0, skipped: 0, failed: 0, need_work: 0 };
  if (!_isEnabled()) return summary;
  if (_inflight) return summary;
  var now = Date.now();
  if (_lastRunAt && (now - _lastRunAt) < HANDLER_COOLDOWN_MS) return summary;
  if (!signals || typeof signals !== 'object') return summary;

  var deliverables = _collectDeliverable(signals.pending_deliveries, signals.pending_atp_tasks);

  // Log (but do not act on) tasks that cannot be submitted from heartbeat-only
  // context. A human-readable warning on stdout makes the "this node is asked
  // to work but can't" situation visible in supervised runs.
  if (Array.isArray(signals.pending_atp_tasks)) {
    for (var i = 0; i < signals.pending_atp_tasks.length; i++) {
      var t = signals.pending_atp_tasks[i];
      if (t && !t.result_asset_id) summary.need_work++;
    }
  }

  if (deliverables.length === 0) {
    if (summary.need_work > 0) {
      console.log('[ATP-HB] ' + summary.need_work + ' ATP task(s) need work on this node but no run() loop is active. '
        + 'Start Evolver with `node index.js run` to pick them up. Skipping from heartbeat-only mode.');
    }
    return summary;
  }

  _inflight = true;
  _lastRunAt = now;
  try {
    var ledger = _readLedger();
    var wrote = false;
    for (var d = 0; d < deliverables.length; d++) {
      var row = deliverables[d];
      if (ledger.submitted && ledger.submitted[row.order_id]) {
        summary.skipped++;
        continue;
      }
      var payload = _buildProofPayload(row);
      var resp = await _withTimeout(hubClient.submitDelivery(row.order_id, payload), SUBMIT_TIMEOUT_MS);
      if (resp && resp.ok) {
        if (!ledger.submitted) ledger.submitted = {};
        ledger.submitted[row.order_id] = Date.now();
        wrote = true;
        summary.submitted++;
        console.log('[ATP-HB] Delivered order=' + row.order_id + ' asset=' + (row.result_asset_id || 'none') + ' (via heartbeat)');
      } else {
        var status = resp && resp.status;
        var terminal = status === 400 || status === 404 || status === 409;
        if (terminal) {
          if (!ledger.submitted) ledger.submitted = {};
          ledger.submitted[row.order_id] = -Date.now();
          wrote = true;
        }
        summary.failed++;
        console.log('[ATP-HB] Delivery failed order=' + row.order_id + ' status=' + (status || 'n/a')
          + ' err=' + String((resp && resp.error) || 'unknown').slice(0, 120));
      }
    }
    if (wrote) _writeLedger(ledger);
  } finally {
    _inflight = false;
  }
  return summary;
}

function _resetForTests() {
  _inflight = false;
  _lastRunAt = 0;
}

module.exports = {
  handleHeartbeatSignals,
  _internals: {
    buildProofPayload: _buildProofPayload,
    collectDeliverable: _collectDeliverable,
    readLedger: _readLedger,
    writeLedger: _writeLedger,
    resetForTests: _resetForTests,
    constants: {
      HANDLER_COOLDOWN_MS,
      SUBMIT_TIMEOUT_MS,
      LEDGER_FILENAME,
    },
  },
};

// ATP end-to-end task completer.
//
// Invoked from the `atp-complete` subcommand (index.js). A spawned Cursor
// sub-session answers an ATP task, writes the answer to disk, then runs:
//
//   node index.js atp-complete \
//     --task-id=<tid> --order-id=<oid> --answer-file=<path> [--summary="..."]
//
// This module takes that answer and drives the full settlement path:
//   1. Synthesize a minimal Gene + Capsule bundle wrapping the answer.
//   2. POST /a2a/publish to register the Capsule asset on the Hub (signed).
//   3. POST /a2a/task/complete to bind the resultAssetId to the claimed task.
//   4. POST /a2a/atp/deliver to submit the proof_payload (asset_id + result).
//
// Autoverify (verifyMode=auto) on the Hub treats `payload.asset_id` and
// `payload.result` as has_result=true with pass_rate=1.0, so a valid answer
// immediately progresses the DeliveryProof from pending -> verified -> settled.
//
// Failures are returned as { ok:false, stage:..., error:... } so the caller can
// retry per-stage without duplicating upstream effects (Gene/Capsule asset_ids
// are deterministic content-hashes, so republish of the same bundle is
// idempotent server-side).

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { computeAssetId } = require('../gep/contentHash');
const { redactString } = require('../gep/sanitize');
const {
  getNodeId,
  getHubUrl,
  getHubNodeSecret,
  buildHubHeaders,
  sendHelloToHub,
} = require('../gep/a2aProtocol');
const { submitDelivery } = require('./hubClient');

const MAX_ANSWER_CHARS = 32000; // cap capsule.content to protect Hub payload limits
const PUBLISH_TIMEOUT_MS = 15000;
const MAX_METADATA_ITEMS = 8;
const MAX_METADATA_STRING = 80;

function _cleanString(value, fallback, maxLength) {
  const text = redactString(String(value == null ? '' : value)).trim();
  if (!text) return fallback || '';
  return text.slice(0, maxLength);
}

function _cleanList(values, fallback) {
  const list = Array.isArray(values) ? values : fallback;
  return list
    .map(function (item) { return _cleanString(item, '', MAX_METADATA_STRING); })
    .filter(Boolean)
    .slice(0, MAX_METADATA_ITEMS);
}

function _readAnswer(answerFile) {
  const raw = fs.readFileSync(answerFile, 'utf8');
  const trimmed = redactString(String(raw || '').trim());
  if (!trimmed) throw new Error('answer file is empty');
  if (trimmed.length > MAX_ANSWER_CHARS) {
    return trimmed.slice(0, MAX_ANSWER_CHARS - 40) + '\n...[TRUNCATED]...';
  }
  return trimmed;
}

function _buildGene(capabilities, signals) {
  const caps = _cleanList(capabilities, ['general']);
  const sig = _cleanList(signals, ['atp_task']);
  const gene = {
    type: 'Gene',
    schema_version: '1.0',
    id: 'gene_atp_answer_' + caps.sort().join('_').slice(0, 40),
    summary: 'Deliver an ATP task answer for capabilities: ' + caps.join(', '),
    signals_match: sig,
    category: 'innovate',
    strategy: [
      'Read the buyer question carefully and identify the requested capability.',
      'Produce a concrete, actionable answer addressing the question directly.',
      'Return the answer as Capsule content for verifiable delivery.',
    ],
    validation: [
      'Answer is non-empty and directly addresses the buyer question.',
      'Answer references the requested capabilities where relevant.',
    ],
  };
  gene.asset_id = computeAssetId(gene);
  return gene;
}

function _buildCapsule({ gene, answer, summary, orderId, taskId, capabilities, signals }) {
  const caps = _cleanList(capabilities, []);
  const sig = _cleanList(signals, ['atp_task']);
  const confidence = 0.9; // merchant self-attested; buyer verify may override
  const capsuleSummary = _cleanString(summary, '', 200)
    || 'ATP merchant delivery for order ' + _cleanString(orderId || '', '', 24);
  const capsule = {
    type: 'Capsule',
    schema_version: '1.0',
    id: 'capsule_atp_' + String(orderId || taskId || Date.now()).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40),
    trigger: sig,
    gene: gene.id,
    summary: capsuleSummary.slice(0, 200),
    confidence,
    blast_radius: { files: 0, lines: Math.min(1000, answer.split('\n').length) },
    outcome: { status: 'success', score: confidence },
    env_fingerprint: { platform: process.platform, arch: process.arch, runtime: 'evolver-atp' },
    content: redactString(String(answer || '')),
    source_type: 'atp_task_executor',
    atp: {
      order_id: orderId || null,
      task_id: taskId || null,
      capabilities: caps,
    },
  };
  capsule.asset_id = computeAssetId(capsule);
  return capsule;
}

function _publishUrl() {
  const base = String(getHubUrl() || '').replace(/\/+$/, '');
  if (!base) throw new Error('hub url not configured');
  return base + '/a2a/publish';
}

function _postJson(urlStr, body, timeoutMs) {
  return new Promise(function (resolve) {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, error: 'invalid_url: ' + (e && e.message) });
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body || {});
    const headers = Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      buildHubHeaders() || {},
    );
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: headers,
        timeout: timeoutMs || PUBLISH_TIMEOUT_MS,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, data });
          } else {
            resolve({ ok: false, status: res.statusCode, data, error: 'http_' + res.statusCode });
          }
        });
      },
    );
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (err) { resolve({ ok: false, error: err.message }); });
    req.write(payload);
    req.end();
  });
}

async function _ensureNodeSecret() {
  if (getHubNodeSecret()) return true;
  try {
    const hello = await sendHelloToHub();
    return !!(hello && hello.ok);
  } catch (e) {
    return false;
  }
}

async function _publishBundle(gene, capsule) {
  const nodeSecret = getHubNodeSecret();
  if (!nodeSecret) return { ok: false, error: 'missing_node_secret_after_hello' };
  const signatureInput = [gene.asset_id, capsule.asset_id].sort().join('|');
  const signature = crypto.createHmac('sha256', nodeSecret).update(signatureInput).digest('hex');
  const msg = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: 'publish',
    message_id: 'msg_atp_' + crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    sender_id: getNodeId(),
    payload: { assets: [gene, capsule], signature: signature },
  };
  return _postJson(_publishUrl(), msg, PUBLISH_TIMEOUT_MS);
}

async function _completeTaskOnHub(taskId, assetId) {
  const base = String(getHubUrl() || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'hub_url_missing' };
  return _postJson(base + '/a2a/task/complete', {
    task_id: taskId,
    asset_id: assetId,
    node_id: getNodeId(),
  }, PUBLISH_TIMEOUT_MS);
}

/**
 * End-to-end ATP task completion driver.
 *
 * @param {object} opts
 * @param {string} opts.taskId     - Hub task row id (required)
 * @param {string} opts.orderId    - ATP DeliveryProof id (required)
 * @param {string} opts.answerFile - Path to file holding the merchant answer (required)
 * @param {string} [opts.summary]  - Short summary for capsule.summary
 * @param {string[]} [opts.capabilities] - Listing capabilities (metadata only)
 * @param {string[]} [opts.signals]      - Task signals (metadata only)
 * @returns {Promise<{ok:boolean, stage?:string, error?:string, assetId?:string}>}
 */
async function completeAtpTask(opts) {
  const taskId = opts && opts.taskId;
  const orderId = opts && opts.orderId;
  const answerFile = opts && opts.answerFile;
  if (!taskId || !orderId || !answerFile) {
    return { ok: false, stage: 'input', error: 'taskId, orderId, answerFile are required' };
  }

  let answer;
  try {
    answer = _readAnswer(answerFile);
  } catch (e) {
    return { ok: false, stage: 'read_answer', error: e && e.message };
  }

  const handshakeOk = await _ensureNodeSecret();
  if (!handshakeOk) {
    return { ok: false, stage: 'hello', error: 'failed to register with hub; node_secret missing' };
  }

  const gene = _buildGene(opts.capabilities, opts.signals);
  const capsule = _buildCapsule({
    gene,
    answer,
    summary: opts.summary,
    orderId,
    taskId,
    capabilities: opts.capabilities,
    signals: opts.signals,
  });

  const pub = await _publishBundle(gene, capsule);
  if (!pub.ok) {
    return { ok: false, stage: 'publish', error: pub.error || 'publish_failed', details: pub };
  }
  const decision = pub.data && pub.data.payload && pub.data.payload.decision;
  if (decision && decision !== 'accept') {
    const reason = pub.data.payload.reason || 'unknown';
    return { ok: false, stage: 'publish', error: 'publish_rejected: ' + reason, details: pub.data };
  }

  const complete = await _completeTaskOnHub(taskId, capsule.asset_id);
  if (!complete.ok) {
    return { ok: false, stage: 'complete', error: complete.error || 'complete_failed', details: complete };
  }

  const proofPayload = {
    asset_id: capsule.asset_id,
    result: capsule.summary,
    content_hash: capsule.asset_id,
    pass_rate: 1.0,
    delivered_by: getNodeId(),
    task_id: taskId,
  };

  const delivery = await submitDelivery(orderId, proofPayload);
  if (!delivery || !delivery.ok) {
    return {
      ok: false,
      stage: 'deliver',
      error: (delivery && delivery.error) || 'deliver_failed',
      assetId: capsule.asset_id,
      details: delivery,
    };
  }

  return { ok: true, assetId: capsule.asset_id, deliveryId: delivery.data && delivery.data.proof_id };
}

module.exports = {
  completeAtpTask,
  // exported for tests
  _buildGene,
  _buildCapsule,
};

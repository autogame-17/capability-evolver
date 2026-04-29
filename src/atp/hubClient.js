// ATP (Agent Transaction Protocol) Hub Client
// Wraps /a2a/atp/* endpoints for evolver-based agents.
//
// Routing rules (#460 Bug 2):
//   - When EVOMAP_PROXY=1 (or A2A_TRANSPORT=mailbox) AND a local proxy is
//     running (settings.json contains proxy.url), all ATP requests are
//     forwarded to the proxy's /atp/* passthrough routes so the proxy is the
//     single egress point (matches mailbox/task/session behavior).
//   - Otherwise, requests go directly to the Hub via the legacy _hubPost /
//     _hubGet path, preserving the 1.69.x and earlier behavior for users who
//     never started the proxy.
//
// The proxy overrides sender_id with its own node_id, so callers must be on
// the same node as the running proxy. This is enforced server-side (proxy is
// bound to 127.0.0.1).

const http = require('http');
const { getHubUrl, buildHubHeaders, getNodeId } = require('../gep/a2aProtocol');
const { getProxyUrl, getProxyRequestHeaders } = require('../proxy/server/settings');

function _isProxyMode() {
  if (process.env.EVOMAP_PROXY === '1') return true;
  if (process.env.A2A_TRANSPORT === 'mailbox') return true;
  return false;
}

function _proxyRequest(method, path, body, timeoutMs) {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return Promise.resolve({ ok: false, error: 'proxy_not_running' });

  const url = new URL(path, proxyUrl);
  const timeout = timeoutMs || require('../config').HTTP_TRANSPORT_TIMEOUT_MS;

  return new Promise(function (resolve) {
    const payload = body ? JSON.stringify(body) : '';
    const headers = Object.assign({ 'Content-Type': 'application/json' }, getProxyRequestHeaders());
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search || ''),
        method: method,
        headers: headers,
        timeout: timeout,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const raw = Buffer.concat(chunks).toString();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve({ ok: true, data: JSON.parse(raw) }); }
            catch (_) { resolve({ ok: true, data: { raw: raw } }); }
          } else {
            resolve({ ok: false, status: res.statusCode, error: raw.slice(0, 400) });
          }
        });
      }
    );
    req.on('error', function (err) { resolve({ ok: false, error: err.message }); });
    req.on('timeout', function () { req.destroy(); resolve({ ok: false, error: 'proxy_timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function _hubPost(pathSuffix, body, timeoutMs) {
  const hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });
  const endpoint = hubUrl.replace(/\/+$/, '') + pathSuffix;
  const timeout = timeoutMs || require('../config').HTTP_TRANSPORT_TIMEOUT_MS;
  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { ok: false, status: res.status, error: t.slice(0, 400) }; });
      return res.json().then(function (data) { return { ok: true, data: data }; });
    })
    .catch(function (err) { return { ok: false, error: err.message }; });
}

function _hubGet(pathSuffix, timeoutMs) {
  const hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });
  const endpoint = hubUrl.replace(/\/+$/, '') + pathSuffix;
  const timeout = timeoutMs || require('../config').HTTP_TRANSPORT_TIMEOUT_MS;
  return fetch(endpoint, {
    method: 'GET',
    headers: buildHubHeaders(),
    signal: AbortSignal.timeout(timeout),
  })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { ok: false, status: res.status, error: t.slice(0, 400) }; });
      return res.json().then(function (data) { return { ok: true, data: data }; });
    })
    .catch(function (err) { return { ok: false, error: err.message }; });
}

// Dispatcher: choose proxy or direct hub based on env + proxy availability.
// proxyPath is the path relative to proxy root (e.g. '/atp/order').
// hubPath is the path relative to hub root (e.g. '/a2a/atp/order').
function _post(proxyPath, hubPath, body, timeoutMs) {
  if (_isProxyMode() && getProxyUrl()) {
    return _proxyRequest('POST', proxyPath, body, timeoutMs);
  }
  return _hubPost(hubPath, body, timeoutMs);
}

function _get(proxyPath, hubPath, timeoutMs) {
  if (_isProxyMode() && getProxyUrl()) {
    return _proxyRequest('GET', proxyPath, null, timeoutMs);
  }
  return _hubGet(hubPath, timeoutMs);
}

/**
 * POST /a2a/atp/order -- place an ATP order with routing
 * @param {object} opts
 * @param {string[]} opts.capabilities - required capabilities
 * @param {number} opts.budget - max credits to spend
 * @param {string} [opts.routingMode] - fastest | cheapest | auction | swarm
 * @param {string} [opts.verifyMode] - auto | ai_judge | bilateral
 * @param {string} [opts.question] - order description
 * @param {string[]} [opts.signals] - matching signals
 * @param {number} [opts.minReputation] - minimum merchant reputation
 */
function placeOrder(opts) {
  const nodeId = getNodeId();
  return _post('/atp/order', '/a2a/atp/order', {
    sender_id: nodeId,
    capabilities: opts.capabilities,
    budget: Math.max(1, Math.round(Number(opts.budget) || 10)),
    routing_mode: opts.routingMode || 'fastest',
    verify_mode: opts.verifyMode || 'auto',
    question: opts.question,
    signals: opts.signals,
    min_reputation: opts.minReputation,
  });
}

/**
 * POST /a2a/atp/deliver -- submit delivery proof for an order
 * @param {string} orderId
 * @param {object} proofPayload - delivery evidence (result, output, pass_rate, etc.)
 */
function submitDelivery(orderId, proofPayload) {
  const nodeId = getNodeId();
  return _post('/atp/deliver', '/a2a/atp/deliver', {
    sender_id: nodeId,
    order_id: orderId,
    proof_payload: proofPayload || {},
  });
}

/**
 * POST /a2a/atp/verify -- confirm or trigger AI judge verification
 * @param {string} orderId
 * @param {string} action - 'confirm' | 'ai_judge'
 */
function verifyDelivery(orderId, action) {
  const nodeId = getNodeId();
  return _post('/atp/verify', '/a2a/atp/verify', {
    sender_id: nodeId,
    order_id: orderId,
    action: action || 'confirm',
  });
}

/**
 * POST /a2a/atp/settle -- force settlement
 * @param {string} orderId
 */
function settleOrder(orderId) {
  const nodeId = getNodeId();
  return _post('/atp/settle', '/a2a/atp/settle', {
    sender_id: nodeId,
    order_id: orderId,
  });
}

/**
 * POST /a2a/atp/dispute -- raise a dispute
 * @param {string} orderId
 * @param {string} reason - dispute reason (min 10 chars)
 */
function disputeOrder(orderId, reason) {
  const nodeId = getNodeId();
  return _post('/atp/dispute', '/a2a/atp/dispute', {
    sender_id: nodeId,
    order_id: orderId,
    reason: reason,
  });
}

/**
 * GET /a2a/atp/merchant/tier?node_id=... -- query merchant tier
 * @param {string} [nodeId] - defaults to own node
 */
function getMerchantTier(nodeId) {
  const nid = nodeId || getNodeId();
  const q = '?node_id=' + encodeURIComponent(nid);
  return _get('/atp/merchant/tier' + q, '/a2a/atp/merchant/tier' + q);
}

/**
 * GET /a2a/atp/order/:orderId -- check order status
 * @param {string} orderId
 */
function getOrderStatus(orderId) {
  const suffix = '/' + encodeURIComponent(orderId);
  return _get('/atp/order' + suffix, '/a2a/atp/order' + suffix);
}

/**
 * GET /a2a/atp/proofs?node_id=...&role=... -- list delivery proofs
 * @param {object} [opts]
 * @param {string} [opts.role] - merchant | consumer
 * @param {string} [opts.status] - pending | verified | disputed | settled
 * @param {number} [opts.limit]
 */
function listProofs(opts) {
  const params = new URLSearchParams();
  params.set('node_id', getNodeId());
  if (opts && opts.role) params.set('role', opts.role);
  if (opts && opts.status) params.set('status', opts.status);
  if (opts && opts.limit) params.set('limit', String(opts.limit));
  const q = '?' + params.toString();
  return _get('/atp/proofs' + q, '/a2a/atp/proofs' + q);
}

/**
 * GET /a2a/atp/policy -- get ATP policy config
 */
function getAtpPolicy() {
  return _get('/atp/policy', '/a2a/atp/policy');
}

/**
 * GET /a2a/task/my?node_id=... -- list this node's claimed tasks
 *
 * ATP-originated tasks include an `atp_order_id` field on each task so the
 * merchant side can pair a completed task with its DeliveryProof and call
 * submitDelivery. Non-ATP tasks simply omit the field. This is NOT an
 * /atp/* endpoint so it never routes through the proxy passthrough.
 *
 * @param {number} [limit]
 */
function listMyTasks(limit) {
  const nid = getNodeId();
  const params = new URLSearchParams();
  params.set('node_id', nid);
  if (limit) params.set('limit', String(limit));
  const suffix = '/a2a/task/my?' + params.toString();
  return _hubGet(suffix);
}

module.exports = {
  placeOrder,
  submitDelivery,
  verifyDelivery,
  settleOrder,
  disputeOrder,
  getMerchantTier,
  getOrderStatus,
  listProofs,
  getAtpPolicy,
  listMyTasks,
  // exported for tests only
  _isProxyMode: _isProxyMode,
};

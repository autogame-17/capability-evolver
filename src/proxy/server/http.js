'use strict';

const http = require('http');
const { writeSettings, clearSettings, clearIfStale, createProxyAuthToken } = require('./settings');

const MAX_PORT_ATTEMPTS = 100;
const DEFAULT_PORT = 19820;

// GHSA-7xp7-m392-h92c: cap request body at 1 MiB. The proxy's HTTP surface is
// bound to 127.0.0.1 but still reachable by any local process (other users on
// a shared dev host, container neighbors sharing the host netns, malicious
// postinstall scripts). Without a cap, /asset/submit and /mailbox/send write
// the full body verbatim into messages.jsonl, so an attacker can fill the
// disk and make the daemon OOM on every restart (readFileSync over a multi-
// GB JSONL). Tune via EVOMAP_PROXY_MAX_BODY_BYTES if a legitimate workload
// truly needs bigger bodies.
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
function resolveMaxBodyBytes() {
  const raw = Number(process.env.EVOMAP_PROXY_MAX_BODY_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_BODY_BYTES;
}

function parseBody(req, opts) {
  const maxBytes = (opts && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)
    ? opts.maxBytes
    : resolveMaxBodyBytes();
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      return reject(err);
    }
    const chunks = [];
    let received = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      received += c.length;
      if (received > maxBytes) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        return fail(err);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', fail);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') return resolve(false);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
}

class ProxyHttpServer {
  constructor(routes, { port, logger } = {}) {
    this.routes = routes;
    this.basePort = port || Number(process.env.EVOMAP_PROXY_PORT) || DEFAULT_PORT;
    this.actualPort = null;
    this.logger = logger || console;
    this.server = null;
    this.requireAuth = String(process.env.EVOMAP_PROXY_REQUIRE_AUTH || 'true').toLowerCase() !== 'false';
    this.authToken = createProxyAuthToken();
  }

  async start() {
    clearIfStale();
    this.server = http.createServer((req, res) => this._handleRequest(req, res));

    let port = this.basePort;
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const ok = await tryListen(this.server, port);
      if (ok) {
        this.actualPort = port;
        const url = `http://127.0.0.1:${port}`;
        writeSettings({
          proxy: {
            url,
            pid: process.pid,
            started_at: new Date().toISOString(),
            auth_token: this.authToken,
          },
        });
        this.logger.log(`[proxy] HTTP server listening on ${url}`);
        return { port, url };
      }
      port++;
    }
    throw new Error(`Could not find free port after ${MAX_PORT_ATTEMPTS} attempts starting from ${this.basePort}`);
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    clearSettings();
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.actualPort}`);
    const routeKey = `${req.method} ${url.pathname}`;

    if (this.requireAuth) {
      const provided = req.headers['x-evomap-proxy-token'];
      if (!provided || provided !== this.authToken) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
    }

    const paramMatch = this._matchRoute(req.method, url.pathname);

    if (!paramMatch) {
      return sendJson(res, 404, { error: 'Not found', path: url.pathname });
    }

    const { handler, params } = paramMatch;

    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await parseBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const result = await handler({ body, query, params });
      sendJson(res, result.status || 200, result.body || result);
    } catch (err) {
      this.logger.error(`[proxy] ${routeKey} error:`, err.message);
      sendJson(res, err.statusCode || 500, {
        error: err.message || 'Internal error',
      });
    }
  }

  _matchRoute(method, pathname) {
    for (const [pattern, handler] of Object.entries(this.routes)) {
      const [routeMethod, routePath] = pattern.split(' ');
      if (routeMethod !== method) continue;

      const params = matchPath(routePath, pathname);
      if (params !== null) return { handler, params };
    }
    return null;
  }
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

module.exports = { ProxyHttpServer, parseBody, sendJson, DEFAULT_PORT, DEFAULT_MAX_BODY_BYTES, resolveMaxBodyBytes };

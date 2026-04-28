'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MailboxStore } = require('../src/proxy/mailbox/store');
const { ProxyHttpServer, DEFAULT_PORT } = require('../src/proxy/server/http');
const { buildRoutes } = require('../src/proxy/server/routes');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
}

let defaultHeaders = {};

function request(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }, defaultHeaders, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('ProxyHttpServer', () => {
  let store, server, baseUrl, dataDir, settingsDir;

  before(async () => {
    dataDir = tmpDataDir();
    settingsDir = tmpDataDir();
    process.env.EVOLVER_SETTINGS_DIR = settingsDir;
    store = new MailboxStore(dataDir);

    const mockProxyHandlers = {
      assetFetch: async (body) => ({ assets: [], query: body }),
      assetSearch: async (body) => ({ results: [], query: body }),
      assetValidate: async (body) => ({ valid: true, asset_id: body.asset_id || 'test' }),
    };

    const routes = buildRoutes(store, mockProxyHandlers, null, {});

    server = new ProxyHttpServer(routes, { port: 39820, logger: { log: () => {}, error: () => {}, warn: () => {} } });
    const info = await server.start();
    baseUrl = info.url;
    defaultHeaders = { 'x-evomap-proxy-token': server.authToken };
  });

  after(async () => {
    defaultHeaders = {};
    await server.stop();
    store.close();
    delete process.env.EVOLVER_SETTINGS_DIR;
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
    try { fs.rmSync(settingsDir, { recursive: true }); } catch {}
  });

  it('rejects requests without proxy auth token', async () => {
    const res = await request(`${baseUrl}/mailbox/list?type=test`, 'GET', null, {
      'x-evomap-proxy-token': '',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  describe('POST /mailbox/send', () => {
    it('sends a message and returns message_id', async () => {
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', {
        type: 'asset_submit',
        payload: { data: 'test' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
      assert.equal(res.body.status, 'pending');
    });

    it('rejects missing type', async () => {
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', {
        payload: { data: 'test' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing payload', async () => {
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', {
        type: 'test',
      });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /mailbox/poll', () => {
    it('returns inbound messages', async () => {
      store.writeInbound({ type: 'poll_test', payload: { x: 1 } });
      const res = await request(`${baseUrl}/mailbox/poll`, 'POST', {
        type: 'poll_test',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.messages.length >= 1);
    });
  });

  describe('POST /mailbox/ack', () => {
    it('acknowledges messages', async () => {
      const id = store.writeInbound({ type: 'ack_test', payload: {} });
      const res = await request(`${baseUrl}/mailbox/ack`, 'POST', {
        message_ids: [id],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.acknowledged, 1);
    });

    it('rejects missing message_ids', async () => {
      const res = await request(`${baseUrl}/mailbox/ack`, 'POST', {});
      assert.equal(res.status, 400);
    });
  });

  describe('GET /mailbox/status/:id', () => {
    it('returns message details', async () => {
      const { message_id } = store.send({ type: 'status_test', payload: { test: true } });
      const res = await request(`${baseUrl}/mailbox/status/${message_id}`, 'GET');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, message_id);
      assert.equal(res.body.type, 'status_test');
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(`${baseUrl}/mailbox/status/nonexistent`, 'GET');
      assert.equal(res.status, 404);
    });
  });

  describe('GET /mailbox/list', () => {
    it('lists messages by type', async () => {
      store.send({ type: 'list_http_test', payload: {} });
      const res = await request(`${baseUrl}/mailbox/list?type=list_http_test`, 'GET');
      assert.equal(res.status, 200);
      assert.ok(res.body.messages.length >= 1);
    });

    it('requires type query param', async () => {
      const res = await request(`${baseUrl}/mailbox/list`, 'GET');
      assert.equal(res.status, 400);
    });
  });

  describe('POST /asset/submit', () => {
    it('queues asset submission via mailbox', async () => {
      const res = await request(`${baseUrl}/asset/submit`, 'POST', {
        assets: [{ type: 'Gene', content: 'test' }],
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
    });

    it('rejects missing assets and asset_id', async () => {
      const res = await request(`${baseUrl}/asset/submit`, 'POST', {
        priority: 'high',
      });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /asset/validate', () => {
    it('validates asset via proxy', async () => {
      const res = await request(`${baseUrl}/asset/validate`, 'POST', {
        asset_id: 'sha256:abc',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
    });

    it('rejects missing asset_id and assets', async () => {
      const res = await request(`${baseUrl}/asset/validate`, 'POST', {});
      assert.equal(res.status, 400);
    });
  });

  describe('GET /asset/submissions', () => {
    it('lists asset submissions with results', async () => {
      store.send({ type: 'asset_submit', payload: { assets: [{ type: 'Gene' }] } });
      const res = await request(`${baseUrl}/asset/submissions`, 'GET');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.submissions));
      assert.ok(res.body.count >= 1);
    });
  });

  describe('POST /asset/fetch', () => {
    it('proxies fetch request (mock)', async () => {
      const res = await request(`${baseUrl}/asset/fetch`, 'POST', {
        asset_ids: ['sha256:abc'],
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.assets);
    });
  });

  describe('POST /asset/search', () => {
    it('proxies search request (mock)', async () => {
      const res = await request(`${baseUrl}/asset/search`, 'POST', {
        signals: ['log_error'],
        mode: 'semantic',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.results);
    });
  });

  describe('Task routes', () => {
    it('POST /task/subscribe returns message_id', async () => {
      const res = await request(`${baseUrl}/task/subscribe`, 'POST', {});
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
    });

    it('POST /task/claim requires task_id', async () => {
      const res = await request(`${baseUrl}/task/claim`, 'POST', {});
      assert.equal(res.status, 400);
    });

    it('POST /task/claim accepts valid task_id', async () => {
      const res = await request(`${baseUrl}/task/claim`, 'POST', { task_id: 'task_123' });
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
    });

    it('POST /task/complete requires task_id', async () => {
      const res = await request(`${baseUrl}/task/complete`, 'POST', {});
      assert.equal(res.status, 400);
    });

    it('POST /task/complete accepts valid data', async () => {
      const res = await request(`${baseUrl}/task/complete`, 'POST', {
        task_id: 'task_123',
        asset_id: 'sha256:abc',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
    });
  });

  describe('GET /task/metrics', () => {
    it('returns task metrics (null monitor)', async () => {
      const res = await request(`${baseUrl}/task/metrics`, 'GET');
      assert.equal(res.status, 200);
      assert.equal(res.body.subscribed, false);
    });
  });

  describe('DM routes', () => {
    it('POST /dm/send sends a direct message', async () => {
      const res = await request(`${baseUrl}/dm/send`, 'POST', {
        recipient_node_id: 'node_xyz',
        content: 'Hello from test',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message_id);
    });

    it('POST /dm/send rejects missing recipient', async () => {
      const res = await request(`${baseUrl}/dm/send`, 'POST', {
        content: 'Hello',
      });
      assert.equal(res.status, 400);
    });

    it('POST /dm/send rejects missing content', async () => {
      const res = await request(`${baseUrl}/dm/send`, 'POST', {
        recipient_node_id: 'node_xyz',
      });
      assert.equal(res.status, 400);
    });

    it('POST /dm/poll returns DM messages', async () => {
      store.writeInbound({ type: 'dm', payload: { content: 'test dm' } });
      const res = await request(`${baseUrl}/dm/poll`, 'POST', {});
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.messages));
    });

    it('GET /dm/list lists DM history', async () => {
      const res = await request(`${baseUrl}/dm/list`, 'GET');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.messages));
    });
  });

  describe('GET /proxy/status', () => {
    it('returns proxy status with version info', async () => {
      const res = await request(`${baseUrl}/proxy/status`, 'GET');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'running');
      assert.ok('outbound_pending' in res.body);
      assert.ok('inbound_pending' in res.body);
      assert.ok(res.body.proxy_protocol_version, 'should include proxy_protocol_version');
      assert.ok(res.body.schema_version, 'should include schema_version');
      assert.match(res.body.proxy_protocol_version, /^\d+\.\d+\.\d+$/);
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(`${baseUrl}/nonexistent`, 'GET');
      assert.equal(res.status, 404);
    });
  });

  describe('body size cap (GHSA-7xp7-m392-h92c)', () => {
    // The proxy binds to 127.0.0.1 but any local process (other users on a
    // shared dev box, sibling containers sharing the netns, malicious
    // postinstall scripts) can still hit it. Without a cap, /mailbox/send and
    // /asset/submit would persist multi-GB payloads into messages.jsonl and
    // exhaust disk / OOM the daemon on every restart.
    it('rejects content-length headers above the default cap with 413', async () => {
      // 2 MiB body, default cap is 1 MiB.
      const big = 'x'.repeat(2 * 1024 * 1024);
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', {
        type: 'hub_event',
        payload: { blob: big },
      });
      assert.equal(res.status, 413, 'oversized body must 413');
      assert.ok(res.body && /too large/i.test(res.body.error || ''),
        'response should explain body too large');
    });

    it('rejects streaming bodies that exceed the cap even when Content-Length lies', async () => {
      // Chunked upload without declared Content-Length: the per-chunk counter
      // must still fire.
      const u = new URL(`${baseUrl}/mailbox/send`);
      const payload = JSON.stringify({ type: 'hub_event', payload: { blob: 'x'.repeat(2 * 1024 * 1024) } });
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
            catch { resolve({ status: res.statusCode, body: raw }); }
          });
        });
        req.on('error', (e) => {
          // The server destroys the socket when the cap is hit. Map socket
          // hang-up into the expected reject-by-413 shape for this assertion.
          if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return resolve({ status: 413, body: { error: 'aborted' } });
          reject(e);
        });
        req.write(payload);
        req.end();
      });
      assert.equal(result.status, 413, 'streaming oversized body must 413 or be aborted');
    });

    it('accepts bodies within the cap', async () => {
      const res = await request(`${baseUrl}/mailbox/send`, 'POST', {
        type: 'hub_event',
        payload: { ok: true },
      });
      assert.ok(res.status === 200 || res.status === 201,
        'small bodies must still pass: got ' + res.status);
    });
  });
});

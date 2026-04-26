'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LifecycleManager } = require('../src/proxy/lifecycle/manager');

function makeStore() {
  const state = {};
  return {
    getState: (k) => state[k] || null,
    setState: (k, v) => { state[k] = v; },
    countPending: () => 0,
    writeInbound: () => {},
    writeInboundBatch: () => {},
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function mockFetch(responseFactory) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return responseFactory(calls.length);
  };
  fn.calls = calls;
  return fn;
}

function responseFromJson({ status = 200, json = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

test('lifecycle hello: sets _helloRateLimitUntil when hub returns 429', async () => {
  const originalFetch = global.fetch;
  try {
    const mf = mockFetch(() => responseFromJson({
      status: 429,
      json: { error: 'hello_rate_limit: max 60/hour per IP' },
      headers: { 'retry-after': '1800' },
    }));
    global.fetch = mf;
    const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store: makeStore(), logger: silentLogger() });
    const result = await mgr.hello();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'hello_rate_limited');
    assert.strictEqual(result.retryAfter, 1800);
    assert.ok(mgr._helloRateLimitUntil > Date.now(), 'rate limit window should be set');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lifecycle hello: suppresses call while rate-limit window is active', async () => {
  const originalFetch = global.fetch;
  try {
    const mf = mockFetch(() => responseFromJson({ status: 200, json: {} }));
    global.fetch = mf;
    const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store: makeStore(), logger: silentLogger() });
    mgr._helloRateLimitUntil = Date.now() + 60_000;
    const result = await mgr.hello();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'hello_rate_limit_active');
    assert.strictEqual(mf.calls.length, 0, 'no network call should be made while rate-limited');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lifecycle reAuthenticate: breaks and sets backoff when hub rotates without returning secret', async () => {
  const originalFetch = global.fetch;
  try {
    const mf = mockFetch(() => responseFromJson({
      status: 200,
      json: { payload: {} },
    }));
    global.fetch = mf;
    const store = makeStore();
    store.setState('node_id', 'node_test');
    const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store, logger: silentLogger() });
    const result = await mgr.reAuthenticate();
    assert.strictEqual(result, false);
    assert.strictEqual(mf.calls.length, 1, 'should break after first missing-secret response, not retry');
    assert.ok(mgr._reauthBackoffUntil > Date.now(), '30-minute backoff should be set');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lifecycle reAuthenticate: suppresses re-entry while backoff window is active', async () => {
  const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store: makeStore(), logger: silentLogger() });
  mgr._reauthBackoffUntil = Date.now() + 30 * 60_000;
  const result = await mgr.reAuthenticate();
  assert.strictEqual(result, false);
});

test('lifecycle reAuthenticate: breaks on hello_rate_limited without retrying', async () => {
  const originalFetch = global.fetch;
  try {
    const mf = mockFetch(() => responseFromJson({
      status: 429,
      json: { error: 'hello_rate_limit: max 60/hour per IP' },
      headers: { 'retry-after': '60' },
    }));
    global.fetch = mf;
    const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store: makeStore(), logger: silentLogger() });
    const result = await mgr.reAuthenticate();
    assert.strictEqual(result, false);
    assert.strictEqual(mf.calls.length, 1, 'should break on rate-limit, not retry second attempt');
    assert.ok(mgr._helloRateLimitUntil > Date.now());
  } finally {
    global.fetch = originalFetch;
  }
});

test('lifecycle _shouldUpgrade: handles prerelease minimum versions', () => {
  const mgr = new LifecycleManager({ hubUrl: 'https://example.test', store: makeStore(), logger: silentLogger() });

  assert.strictEqual(mgr._shouldUpgrade('0.1.0-beta.1'), false);
  assert.strictEqual(mgr._shouldUpgrade('0.1.1-beta.1'), true);
  assert.strictEqual(mgr._shouldUpgrade('0.2.0-beta.1'), true);
});

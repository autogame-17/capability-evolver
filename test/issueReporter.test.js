const assert = require('assert');

const MODULE_PATH = require.resolve('../src/gep/issueReporter');

function withFetchMock(mock, fn) {
  const original = global.fetch;
  global.fetch = mock;
  return Promise.resolve(fn()).finally(function () { global.fetch = original; });
}

function jsonResponse(body, status) {
  return {
    ok: status == null || (status >= 200 && status < 300),
    status: status || 200,
    json: async function () { return body; },
    text: async function () { return JSON.stringify(body); },
  };
}

(async function run() {
  delete require.cache[MODULE_PATH];
  const { findExistingIssue } = require('../src/gep/issueReporter');

  // Case 1: search returns matching open issue -> returns object
  await withFetchMock(async function (url, opts) {
    assert.ok(String(url).includes('/search/issues'), 'should hit search API');
    assert.ok(String(url).includes('is%3Aopen'), 'should request open issues');
    return jsonResponse({
      items: [
        { number: 397, html_url: 'https://github.com/x/y/issues/397', title: '[Auto] Recurring failure: Repeated failures with gene: gene_gep_repair_from_errors', state: 'open' }
      ],
    });
  }, async function () {
    const result = await findExistingIssue('x/y', '[Auto] Recurring failure: Repeated failures with gene: gene_gep_repair_from_errors', 'faketoken');
    assert.ok(result && result.number === 397, 'should find existing open issue');
  });

  // Case 2: search returns no items -> returns null
  await withFetchMock(async function () {
    return jsonResponse({ items: [] });
  }, async function () {
    const result = await findExistingIssue('x/y', '[Auto] Recurring failure: Something new', 'faketoken');
    assert.strictEqual(result, null, 'should return null when no matches');
  });

  // Case 3: search returns only closed issues (API scoped to open via query, but guard client-side)
  await withFetchMock(async function () {
    return jsonResponse({
      items: [
        { number: 100, html_url: 'https://github.com/x/y/issues/100', title: '[Auto] Recurring failure: foo', state: 'closed' }
      ],
    });
  }, async function () {
    const result = await findExistingIssue('x/y', '[Auto] Recurring failure: foo', 'faketoken');
    assert.strictEqual(result, null, 'closed issues should not count');
  });

  // Case 4: network failure -> returns null (non-fatal)
  await withFetchMock(async function () { throw new Error('network down'); }, async function () {
    const result = await findExistingIssue('x/y', '[Auto] Recurring failure: foo', 'faketoken');
    assert.strictEqual(result, null, 'network error should return null');
  });

  // Case 5: non-OK response -> returns null
  await withFetchMock(async function () {
    return { ok: false, status: 403, text: async function () { return 'rate limited'; }, json: async function () { return {}; } };
  }, async function () {
    const result = await findExistingIssue('x/y', '[Auto] Recurring failure: foo', 'faketoken');
    assert.strictEqual(result, null, 'non-OK should return null');
  });

  // Case 6: empty title -> returns null without hitting fetch
  let called = false;
  await withFetchMock(async function () { called = true; return jsonResponse({ items: [] }); }, async function () {
    const result = await findExistingIssue('x/y', '', 'faketoken');
    assert.strictEqual(result, null, 'empty title should short-circuit');
    assert.strictEqual(called, false, 'fetch should not be called for empty title');
  });

  // Case 7: computeErrorKey is stable across occurrence counts
  // (regression: (Nx) prefix had been hashed verbatim, mutating the key
  // every cycle and defeating recentIssueKeys dedup).
  const { computeErrorKey } = require('../src/gep/issueReporter');
  const k3 = computeErrorKey(['recurring_errsig(3x):timeout on API', 'failure_loop_detected']);
  const k4 = computeErrorKey(['recurring_errsig(4x):timeout on API', 'failure_loop_detected']);
  const k5 = computeErrorKey(['recurring_errsig(5x):timeout on API', 'failure_loop_detected']);
  assert.strictEqual(k3, k4, 'errorKey should be stable across (Nx) counts');
  assert.strictEqual(k4, k5, 'errorKey should be stable across (Nx) counts');

  // Case 8: shouldReport enforces minStreak even when the streak signal is
  // absent (regression: prior "streakCount > 0 && < minStreak" guard was a
  // no-op when the consecutive_failure_streak_N signal was missing).
  const { shouldReport } = require('../src/gep/issueReporter');
  const gatedCfg = { repo: 'x/y', cooldownMs: 86400000, minStreak: 5 };
  assert.strictEqual(
    shouldReport(['failure_loop_detected', 'recurring_errsig(2x):foo'], gatedCfg),
    false,
    'minStreak gate must apply when streak signal is absent'
  );
  assert.strictEqual(
    shouldReport(['failure_loop_detected', 'recurring_errsig(2x):foo', 'consecutive_failure_streak_10'], gatedCfg),
    true,
    'should pass when streak meets minStreak'
  );

  // Case 9: findExistingIssue no longer matches unrelated titles via loose
  // substring fallback (regression: prior it.title.indexOf(titleSig) !== -1
  // matched issues that merely contained the search signature).
  await withFetchMock(async function () {
    return jsonResponse({
      items: [
        { number: 12345, state: 'open', html_url: 'https://x/y/12345',
          title: 'META: [Auto] Recurring failure: boom — discussion thread about unrelated context that embeds the above substring' }
      ],
    });
  }, async function () {
    const target = '[Auto] Recurring failure: boom';
    const result = await findExistingIssue('x/y', target, 'faketoken');
    assert.strictEqual(result, null, 'substring fallback must not match unrelated titles');
  });

  console.log('issueReporter.test.js: OK');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});

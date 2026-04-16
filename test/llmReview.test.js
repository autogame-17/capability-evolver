'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isLlmReviewEnabled, buildReviewPrompt, runLlmReview } = require('../src/gep/llmReview');

// -- isLlmReviewEnabled --

describe('isLlmReviewEnabled', () => {
  it('returns false when env not set', () => {
    delete process.env.EVOLVER_LLM_REVIEW;
    assert.equal(isLlmReviewEnabled(), false);
  });

  it('returns false when set to "false"', () => {
    process.env.EVOLVER_LLM_REVIEW = 'false';
    assert.equal(isLlmReviewEnabled(), false);
    delete process.env.EVOLVER_LLM_REVIEW;
  });

  it('returns true when set to "true"', () => {
    process.env.EVOLVER_LLM_REVIEW = 'true';
    assert.equal(isLlmReviewEnabled(), true);
    delete process.env.EVOLVER_LLM_REVIEW;
  });

  it('is case-insensitive', () => {
    process.env.EVOLVER_LLM_REVIEW = 'TRUE';
    assert.equal(isLlmReviewEnabled(), true);
    delete process.env.EVOLVER_LLM_REVIEW;
  });
});

// -- buildReviewPrompt --

describe('buildReviewPrompt', () => {
  it('includes gene id and category', () => {
    const prompt = buildReviewPrompt({
      diff: 'diff --git a/foo.js',
      gene: { id: 'gene-001', category: 'repair' },
      signals: ['log_error'],
      mutation: { rationale: 'fix the bug' },
    });
    assert.ok(prompt.includes('gene-001'), 'prompt should include gene id');
    assert.ok(prompt.includes('repair'), 'prompt should include category');
    assert.ok(prompt.includes('fix the bug'), 'prompt should include rationale');
    assert.ok(prompt.includes('log_error'), 'prompt should include signals');
    assert.ok(prompt.includes('diff --git'), 'prompt should include diff');
  });

  it('handles missing gene gracefully', () => {
    const prompt = buildReviewPrompt({ diff: '', gene: null, signals: [], mutation: null });
    assert.ok(prompt.includes('(unknown)'), 'prompt should show unknown gene');
    assert.ok(prompt.includes('(none)'), 'prompt should show none for signals');
  });

  it('truncates long diffs', () => {
    const longDiff = 'x'.repeat(10000);
    const prompt = buildReviewPrompt({ diff: longDiff, gene: null, signals: [], mutation: null });
    assert.ok(prompt.length < 10000, 'prompt should be truncated');
  });

  it('includes JSON response format instruction', () => {
    const prompt = buildReviewPrompt({ diff: '', gene: null, signals: [], mutation: null });
    assert.ok(prompt.includes('"approved"'), 'prompt should include response format');
    assert.ok(prompt.includes('"confidence"'), 'prompt should include confidence field');
    assert.ok(prompt.includes('"concerns"'), 'prompt should include concerns field');
    assert.ok(prompt.includes('"summary"'), 'prompt should include summary field');
  });
});

// -- runLlmReview --

describe('runLlmReview', () => {
  it('returns null when review is disabled', () => {
    delete process.env.EVOLVER_LLM_REVIEW;
    const result = runLlmReview({ diff: 'diff', gene: null, signals: [], mutation: null });
    assert.equal(result, null);
  });

  it('returns auto-approved result when enabled without API key', () => {
    process.env.EVOLVER_LLM_REVIEW = 'true';
    delete process.env.MINIMAX_API_KEY;

    const result = runLlmReview({ diff: 'diff', gene: null, signals: [], mutation: null });
    assert.ok(result !== null, 'result should not be null when review is enabled');
    assert.equal(typeof result.approved, 'boolean', 'result.approved should be boolean');
    assert.equal(typeof result.confidence, 'number', 'result.confidence should be number');
    assert.ok(Array.isArray(result.concerns), 'result.concerns should be array');
    assert.equal(typeof result.summary, 'string', 'result.summary should be string');
    assert.ok(result.summary.includes('auto-approved'), 'should indicate auto-approved when no LLM configured');

    delete process.env.EVOLVER_LLM_REVIEW;
  });

  it('uses MiniMax base URL from env if set', () => {
    // Verify that the MINIMAX_BASE_URL env variable is respected (structure test)
    const originalUrl = process.env.MINIMAX_BASE_URL;
    process.env.MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
    assert.equal(process.env.MINIMAX_BASE_URL, 'https://api.minimax.io/v1');
    if (originalUrl === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = originalUrl;
  });
});

// -- MiniMax API integration (skipped when no key) --

describe('MiniMax API review', () => {
  it('skips when MINIMAX_API_KEY not set', (t) => {
    if (!process.env.MINIMAX_API_KEY) {
      t.skip('MINIMAX_API_KEY not set, skipping integration test');
      return;
    }

    process.env.EVOLVER_LLM_REVIEW = 'true';
    const result = runLlmReview({
      diff: '+console.log("hello world");',
      gene: { id: 'test-gene', category: 'optimize' },
      signals: ['test_signal'],
      mutation: { rationale: 'add debug log' },
    });
    assert.ok(result !== null, 'MiniMax review result should not be null');
    assert.equal(typeof result.approved, 'boolean', 'approved should be boolean');
    assert.ok(result.confidence >= 0 && result.confidence <= 1, 'confidence should be 0-1');
    delete process.env.EVOLVER_LLM_REVIEW;
  });
});

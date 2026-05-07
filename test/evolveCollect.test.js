'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const collect = require('../src/evolve/pipeline/collect');

// ---------------------------------------------------------------------------
// getMutationDirective
// ---------------------------------------------------------------------------
describe('getMutationDirective', () => {
  it('recommends repair when error count > 2', () => {
    const log = '[ERROR] fail\n[ERROR] fail\nError: something\nFailed to run';
    const result = collect.getMutationDirective(log);
    assert.ok(result.includes('recommended_intent: repair'));
    assert.ok(result.includes('stability: unstable'));
  });

  it('recommends optimize when error count <= 2', () => {
    const result = collect.getMutationDirective('all good, no problems here');
    assert.ok(result.includes('recommended_intent: optimize'));
    assert.ok(result.includes('stability: stable'));
  });

  it('counts "isError":true as an error signal', () => {
    const log = '"isError":true\n"isError":true\n"isError":true';
    const result = collect.getMutationDirective(log);
    assert.ok(result.includes('recommended_intent: repair'));
  });
});

// ---------------------------------------------------------------------------
// checkSystemHealth
// ---------------------------------------------------------------------------
describe('checkSystemHealth', () => {
  it('returns a non-empty string', () => {
    const result = collect.checkSystemHealth();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('includes Node version and uptime', () => {
    const result = collect.checkSystemHealth();
    assert.ok(result.includes('Node:'));
    assert.ok(result.includes('Uptime:'));
  });
});

// ---------------------------------------------------------------------------
// diagnoseSessionSourceEmpty (re-exported from collect)
// ---------------------------------------------------------------------------
describe('diagnoseSessionSourceEmpty', () => {
  it('returns a serializable report with expected shape', () => {
    const diag = collect.diagnoseSessionSourceEmpty({
      homedir: '/tmp/nonexistent-home-xyz',
      agentName: 'test-agent',
      sessionSource: 'auto',
      cursorTranscriptsDir: '',
    });
    assert.equal(typeof diag.sessionSource, 'string');
    assert.equal(typeof diag.agentSessionsDirExists, 'boolean');
    assert.ok(Array.isArray(diag.hints));
    assert.ok(Array.isArray(diag.availableOpenClawAgents));
  });

  it('emits a hint when openclaw forced but dir missing', () => {
    const diag = collect.diagnoseSessionSourceEmpty({
      homedir: '/tmp/nonexistent-home-xyz',
      agentName: 'main',
      agentSessionsDir: '/tmp/nonexistent-xyz/sessions',
      sessionSource: 'openclaw',
      cursorTranscriptsDir: '',
    });
    assert.ok(diag.hints.some(h => h.includes('openclaw')));
  });
});

// ---------------------------------------------------------------------------
// resetSessionSourceWarning
// ---------------------------------------------------------------------------
describe('resetSessionSourceWarning', () => {
  it('does not throw', () => {
    assert.doesNotThrow(() => collect.resetSessionSourceWarning());
  });
});

// ---------------------------------------------------------------------------
// formatCursorTranscript
// ---------------------------------------------------------------------------
describe('formatCursorTranscript', () => {
  it('keeps user and assistant lines', () => {
    const raw = 'user:\nhello\nA: here is the answer';
    const result = collect.formatCursorTranscript(raw);
    assert.ok(result.includes('user:'));
    assert.ok(result.includes('A: here is the answer'));
  });

  it('strips tool result content', () => {
    const raw = 'user:\nask\n[Tool result]\nsome noisy output\nA: done';
    const result = collect.formatCursorTranscript(raw);
    assert.ok(!result.includes('some noisy output'));
    assert.ok(result.includes('A: done'));
  });
});

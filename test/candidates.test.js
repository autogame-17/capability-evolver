const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractCapabilityCandidates, expandSignals } = require('../src/gep/candidates');

describe('expandSignals', () => {
  it('derives structured learning tags from weak signals', () => {
    const tags = expandSignals(['perf_bottleneck', 'stable_success_plateau'], '');
    assert.ok(tags.includes('problem:performance'));
    assert.ok(tags.includes('problem:stagnation'));
    assert.ok(tags.includes('action:optimize'));
  });
});

describe('extractCapabilityCandidates', () => {
  it('creates a failure-driven candidate from repeated failed capsules', () => {
    const result = extractCapabilityCandidates({
      recentSessionTranscript: '',
      signals: ['perf_bottleneck'],
      recentFailedCapsules: [
        { trigger: ['perf_bottleneck'], failure_reason: 'validation failed because latency stayed high', outcome: { status: 'failed' } },
        { trigger: ['perf_bottleneck'], failure_reason: 'constraint violation after slow path regression', outcome: { status: 'failed' } },
      ],
    });
    const failureCandidate = result.find(function (c) { return c.source === 'failed_capsules'; });
    assert.ok(failureCandidate);
    assert.ok(failureCandidate.tags.includes('problem:performance'));
  });
});

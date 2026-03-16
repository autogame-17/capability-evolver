const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeAdaptiveStrategyPolicy } = require('../src/evolve');

describe('computeAdaptiveStrategyPolicy', () => {
  it('forces innovation after repeated repair/failure streaks', () => {
    const policy = computeAdaptiveStrategyPolicy({
      signals: ['stable_success_plateau'],
      selectedGene: { type: 'Gene', id: 'gene_x', constraints: { max_files: 20 } },
      recentEvents: [
        { intent: 'repair', outcome: { status: 'failed' } },
        { intent: 'repair', outcome: { status: 'failed' } },
        { intent: 'repair', outcome: { status: 'failed' } },
      ],
    });
    assert.equal(policy.forceInnovate, true);
    assert.ok(policy.blastRadiusMaxFiles <= 10);
  });

  it('shrinks blast radius for high-risk genes with overlapping anti-patterns', () => {
    const policy = computeAdaptiveStrategyPolicy({
      signals: ['perf_bottleneck'],
      selectedGene: {
        type: 'Gene',
        id: 'gene_perf',
        constraints: { max_files: 18 },
        anti_patterns: [{ mode: 'hard', learning_signals: ['problem:performance'] }],
        learning_history: [],
      },
      recentEvents: [],
    });
    assert.equal(policy.highRiskGene, true);
    assert.ok(policy.blastRadiusMaxFiles <= 6);
    assert.equal(policy.cautiousExecution, true);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectGene, selectCapsule, selectGeneAndCapsule } = require('../src/gep/selector');

const GENES = [
  {
    type: 'Gene',
    id: 'gene_repair',
    category: 'repair',
    signals_match: ['error', 'exception', 'failed'],
    strategy: ['fix it'],
    validation: ['node -e "true"'],
  },
  {
    type: 'Gene',
    id: 'gene_optimize',
    category: 'optimize',
    signals_match: ['protocol', 'prompt', 'audit'],
    strategy: ['optimize it'],
    validation: ['node -e "true"'],
  },
  {
    type: 'Gene',
    id: 'gene_innovate',
    category: 'innovate',
    signals_match: ['user_feature_request', 'user_improvement_suggestion', 'capability_gap', 'stable_success_plateau'],
    strategy: ['build it'],
    validation: ['node -e "true"'],
  },
  {
    type: 'Gene',
    id: 'gene_perf_optimize',
    category: 'optimize',
    signals_match: ['latency', 'throughput'],
    summary: 'Reduce latency and improve throughput on slow paths',
    strategy: ['speed it up'],
    validation: ['node -e "true"'],
  },
];

const CAPSULES = [
  {
    type: 'Capsule',
    id: 'capsule_1',
    trigger: ['log_error', 'exception'],
    gene: 'gene_repair',
    summary: 'Fixed an error',
    confidence: 0.9,
  },
  {
    type: 'Capsule',
    id: 'capsule_2',
    trigger: ['protocol', 'gep'],
    gene: 'gene_optimize',
    summary: 'Optimized prompt',
    confidence: 0.85,
  },
];

describe('selectGene', () => {
  it('selects the gene with highest signal match', () => {
    const result = selectGene(GENES, ['error', 'exception', 'failed'], {});
    assert.equal(result.selected.id, 'gene_repair');
  });

  it('returns null when no signals match', () => {
    const result = selectGene(GENES, ['completely_unrelated_signal'], {});
    assert.equal(result.selected, null);
  });

  it('returns alternatives when multiple genes match', () => {
    const result = selectGene(GENES, ['error', 'protocol'], {});
    assert.ok(result.selected);
    assert.ok(Array.isArray(result.alternatives));
  });

  it('includes drift intensity in result', () => {
    // Drift intensity is population-size-dependent; verify it is returned.
    const result = selectGene(GENES, ['error', 'exception'], {});
    assert.ok('driftIntensity' in result);
    assert.equal(typeof result.driftIntensity, 'number');
    assert.ok(result.driftIntensity >= 0 && result.driftIntensity <= 1);
  });

  it('respects preferred gene id from memory graph', () => {
    const result = selectGene(GENES, ['error', 'protocol'], {
      preferredGeneId: 'gene_optimize',
    });
    // gene_optimize matches 'protocol' so it qualifies as a candidate
    // With preference, it should be selected even if gene_repair scores higher
    assert.equal(result.selected.id, 'gene_optimize');
  });

  it('matches gene via baseName:snippet signal (user_feature_request:snippet)', () => {
    const result = selectGene(GENES, ['user_feature_request:add a dark mode toggle to the settings'], {});
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_innovate', 'innovate gene has signals_match user_feature_request');
  });

  it('matches gene via baseName:snippet signal (user_improvement_suggestion:snippet)', () => {
    const result = selectGene(GENES, ['user_improvement_suggestion:refactor the payment module and simplify the API'], {});
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_innovate', 'innovate gene has signals_match user_improvement_suggestion');
  });

  it('uses derived learning tags to match related performance genes', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.99;
    try {
      const result = selectGene(GENES, ['perf_bottleneck'], { effectivePopulationSize: 100 });
      assert.ok(result.selected);
      assert.equal(result.selected.id, 'gene_perf_optimize');
    } finally {
      Math.random = originalRandom;
    }
  });

  it('downweights genes with repeated hard-fail anti-patterns', () => {
    const riskyGenes = [
      {
        type: 'Gene',
        id: 'gene_perf_risky',
        category: 'optimize',
        signals_match: ['perf_bottleneck'],
        anti_patterns: [
          { mode: 'hard', learning_signals: ['problem:performance'] },
          { mode: 'hard', learning_signals: ['problem:performance'] },
        ],
        validation: ['node -e "true"'],
      },
      {
        type: 'Gene',
        id: 'gene_perf_safe',
        category: 'optimize',
        signals_match: ['perf_bottleneck'],
        learning_history: [
          { outcome: 'success', mode: 'none' },
        ],
        validation: ['node -e "true"'],
      },
    ];
    const result = selectGene(riskyGenes, ['perf_bottleneck'], { effectivePopulationSize: 100 });
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_perf_safe');
  });
});

describe('selectCapsule', () => {
  it('selects capsule matching signals', () => {
    const result = selectCapsule(CAPSULES, ['log_error', 'exception']);
    assert.equal(result.id, 'capsule_1');
  });

  it('returns null when no triggers match', () => {
    const result = selectCapsule(CAPSULES, ['unrelated']);
    assert.equal(result, null);
  });
});

describe('selectGeneAndCapsule', () => {
  it('returns selected gene, capsule candidates, and selector decision', () => {
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'log_error'],
      memoryAdvice: null,
      driftEnabled: false,
    });
    assert.ok(result.selectedGene);
    assert.ok(result.selector);
    assert.ok(result.selector.selected);
    assert.ok(Array.isArray(result.selector.reason));
  });
});

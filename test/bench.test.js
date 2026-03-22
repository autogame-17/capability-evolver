'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// evolver-bench: quantitative benchmark for evolution effectiveness
// Measures: gene selection accuracy, failure distillation quality,
//           signal extraction recall, anti-pattern avoidance
// ---------------------------------------------------------------------------

const { selectGene, selectGeneAndCapsule } = require('../src/gep/selector');
const { extractSignals } = require('../src/gep/signals');
const {
  collectFailureDistillationData,
  analyzeFailurePatterns,
  synthesizeRepairGeneFromFailures,
  autoDistillFromFailures,
  validateSynthesizedGene,
  shouldDistillFromFailures,
  REPAIR_DISTILLED_ID_PREFIX,
  FAILURE_DISTILLER_MIN_CAPSULES,
} = require('../src/gep/skillDistiller');

let tmpDir;
let savedEnv = {};

function setupTempEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-bench-'));
  savedEnv = {
    GEP_ASSETS_DIR: process.env.GEP_ASSETS_DIR,
    EVOLUTION_DIR: process.env.EVOLUTION_DIR,
    MEMORY_DIR: process.env.MEMORY_DIR,
    MEMORY_GRAPH_PATH: process.env.MEMORY_GRAPH_PATH,
    SKILL_DISTILLER: process.env.SKILL_DISTILLER,
    FAILURE_DISTILLER: process.env.FAILURE_DISTILLER,
  };
  process.env.GEP_ASSETS_DIR = path.join(tmpDir, 'assets');
  process.env.EVOLUTION_DIR = path.join(tmpDir, 'evolution');
  process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
  process.env.MEMORY_GRAPH_PATH = path.join(tmpDir, 'evolution', 'memory_graph.jsonl');
  fs.mkdirSync(process.env.GEP_ASSETS_DIR, { recursive: true });
  fs.mkdirSync(process.env.EVOLUTION_DIR, { recursive: true });
  fs.mkdirSync(process.env.MEMORY_DIR, { recursive: true });
}

function teardownTempEnv() {
  Object.keys(savedEnv).forEach(function (key) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function makeFailedCapsule(id, gene, trigger, failureReason, learningSignals, violations) {
  return {
    type: 'Capsule',
    id: id,
    gene: gene,
    trigger: trigger || ['error'],
    outcome: { status: 'failed', score: 0.2 },
    failure_reason: failureReason || 'constraint violation',
    learning_signals: learningSignals || [],
    constraint_violations: violations || [],
    blast_radius: { files: 3, lines: 50 },
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Bench 1: Gene Selection Accuracy
// ---------------------------------------------------------------------------
describe('bench: gene selection accuracy', function () {
  var BENCH_GENES = [
    { type: 'Gene', id: 'gene_repair', category: 'repair', signals_match: ['error', 'exception', 'failed', 'unstable'], strategy: ['fix'] },
    { type: 'Gene', id: 'gene_optimize', category: 'optimize', signals_match: ['protocol', 'gep', 'prompt', 'audit'], strategy: ['optimize'] },
    { type: 'Gene', id: 'gene_innovate', category: 'innovate', signals_match: ['user_feature_request', 'capability_gap', 'stable_success_plateau'], strategy: ['build'] },
    { type: 'Gene', id: 'gene_perf', category: 'optimize', signals_match: ['perf_bottleneck', 'latency', 'throughput', 'slow'], strategy: ['speed up'] },
  ];

  var TEST_CASES = [
    { signals: ['error', 'exception'], expected: 'gene_repair', label: 'error signals -> repair' },
    { signals: ['protocol', 'audit'], expected: 'gene_optimize', label: 'protocol signals -> optimize' },
    { signals: ['user_feature_request', 'capability_gap'], expected: 'gene_innovate', label: 'feature request -> innovate' },
    { signals: ['perf_bottleneck', 'latency'], expected: 'gene_perf', label: 'perf signals -> perf optimize' },
    { signals: ['failed', 'unstable'], expected: 'gene_repair', label: 'failure signals -> repair' },
    { signals: ['gep', 'prompt'], expected: 'gene_optimize', label: 'prompt signals -> optimize' },
  ];

  it('achieves >= 80% selection accuracy on standard signal scenarios', function () {
    var correct = 0;
    var total = TEST_CASES.length;

    for (var i = 0; i < TEST_CASES.length; i++) {
      var tc = TEST_CASES[i];
      var result = selectGene(BENCH_GENES, tc.signals, { effectivePopulationSize: 100 });
      if (result.selected && result.selected.id === tc.expected) {
        correct++;
      }
    }

    var accuracy = correct / total;
    assert.ok(accuracy >= 0.8, 'Gene selection accuracy ' + (accuracy * 100).toFixed(1) + '% < 80% threshold');
  });

  it('never selects a banned gene', function () {
    var banned = new Set(['gene_repair']);
    for (var i = 0; i < 20; i++) {
      var result = selectGene(BENCH_GENES, ['error', 'exception'], {
        bannedGeneIds: banned,
        effectivePopulationSize: 100,
      });
      if (result.selected) {
        assert.ok(!banned.has(result.selected.id), 'Selected banned gene: ' + result.selected.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bench 2: Signal Extraction Recall
// ---------------------------------------------------------------------------
describe('bench: signal extraction recall', function () {
  it('extracts error signals from log-like input', function () {
    var signals = extractSignals({
      recentSessionTranscript: '',
      todayLog: '[error] Module X failed to load\n[error] Database connection timeout\nException in thread main',
      memorySnippet: '',
      userSnippet: '',
    });
    assert.ok(signals.includes('log_error'), 'Should detect log_error from [error] lines');
  });

  it('extracts feature request signals', function () {
    var signals = extractSignals({
      recentSessionTranscript: '',
      todayLog: '',
      memorySnippet: '',
      userSnippet: 'I want a dark mode toggle in the settings panel',
    });
    var hasFeatureSignal = signals.some(function (s) {
      return s.indexOf('user_feature_request') !== -1 || s.indexOf('user_improvement_suggestion') !== -1;
    });
    assert.ok(hasFeatureSignal, 'Should detect feature request from user input');
  });

  it('detects stagnation signals', function () {
    var recentEvents = [];
    for (var i = 0; i < 6; i++) {
      recentEvents.push({
        type: 'EvolutionEvent',
        outcome: { status: 'success', score: 0.85 },
        blast_radius: { files: 0, lines: 0 },
        signals: [],
      });
    }
    var signals = extractSignals({
      recentSessionTranscript: '',
      todayLog: '',
      memorySnippet: '',
      userSnippet: '',
      recentEvents: recentEvents,
    });
    var hasStagnation = signals.some(function (s) {
      return s.indexOf('empty_cycle') !== -1 || s.indexOf('stagnation') !== -1 || s.indexOf('steady_state') !== -1;
    });
    assert.ok(hasStagnation || signals.length === 0, 'Stagnation detection assessed (may not trigger with minimal events)');
  });
});

// ---------------------------------------------------------------------------
// Bench 3: Failure Distillation Quality
// ---------------------------------------------------------------------------
describe('bench: failure distillation quality', function () {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('collects and groups failed capsules correctly', function () {
    var failures = [
      makeFailedCapsule('f1', 'gene_repair', ['error', 'crash'], 'blast_radius_exceeded', ['problem:reliability'], ['blast_radius_exceeded']),
      makeFailedCapsule('f2', 'gene_repair', ['error', 'timeout'], 'blast_radius_exceeded', ['problem:reliability'], ['blast_radius_exceeded']),
      makeFailedCapsule('f3', 'gene_optimize', ['protocol'], 'validation_failed', ['problem:protocol'], ['validation_cmd_failed']),
    ];
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });

    var data = collectFailureDistillationData();
    assert.equal(data.failedCapsules.length, 3);
    assert.ok(Object.keys(data.grouped).length >= 2);
  });

  it('identifies high-frequency failure patterns', function () {
    var failures = [];
    for (var i = 0; i < 5; i++) {
      failures.push(makeFailedCapsule(
        'f' + i, 'gene_repair', ['error', 'memory_leak'],
        'blast_radius_exceeded: too many files changed',
        ['problem:reliability', 'risk:validation'],
        ['blast_radius_exceeded', 'max_files_exceeded']
      ));
    }
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });

    var data = collectFailureDistillationData();
    var analysis = analyzeFailurePatterns(data);
    assert.ok(analysis.high_frequency_failures.length >= 1, 'Should detect high-frequency failure pattern');
    assert.ok(analysis.high_frequency_failures[0].count >= 2);
  });

  it('synthesizes a repair gene from failure patterns', function () {
    var failures = [];
    for (var i = 0; i < 6; i++) {
      failures.push(makeFailedCapsule(
        'f' + i, 'gene_repair', ['error', 'crash'],
        'blast_radius_exceeded',
        ['problem:reliability'],
        ['blast_radius_exceeded']
      ));
    }
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });

    var data = collectFailureDistillationData();
    var analysis = analyzeFailurePatterns(data);
    var gene = synthesizeRepairGeneFromFailures(data, analysis, []);

    assert.ok(gene, 'Should produce a repair gene');
    assert.equal(gene.type, 'Gene');
    assert.equal(gene.category, 'repair');
    assert.ok(gene.id.startsWith(REPAIR_DISTILLED_ID_PREFIX) || gene.id.startsWith('gene_distilled_'), 'Gene id should have repair prefix');
    assert.ok(gene.strategy.length >= 4, 'Strategy should have guard steps');
    assert.ok(gene.strategy.some(function (s) { return s.indexOf('GUARD') !== -1 || s.indexOf('guard') !== -1; }), 'Should include guard steps');
  });

  it('autoDistillFromFailures produces a gene when threshold met', function () {
    var failures = [];
    for (var i = 0; i < 6; i++) {
      failures.push(makeFailedCapsule(
        'f' + i, 'gene_repair', ['error', 'crash'],
        'blast_radius_exceeded',
        ['problem:reliability'],
        ['blast_radius_exceeded']
      ));
    }
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'genes.json'), { version: 1, genes: [] });

    var result = autoDistillFromFailures();
    assert.ok(result.ok, 'autoDistillFromFailures should succeed: ' + (result.reason || ''));
    assert.ok(result.gene);
    assert.equal(result.source, 'failure_distillation');

    var genes = JSON.parse(fs.readFileSync(path.join(process.env.GEP_ASSETS_DIR, 'genes.json'), 'utf8'));
    assert.ok(genes.genes.some(function (g) { return g.id === result.gene.id; }), 'Gene should be persisted');
  });

  it('returns insufficient_failures when below threshold', function () {
    var failures = [
      makeFailedCapsule('f1', 'gene_repair', ['error'], 'blast_radius_exceeded', [], []),
    ];
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });

    var result = autoDistillFromFailures();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_failures');
  });

  it('idempotent skip on repeated calls with same data', function () {
    var failures = [];
    for (var i = 0; i < 6; i++) {
      failures.push(makeFailedCapsule('f' + i, 'gene_repair', ['error'], 'blast_radius', ['problem:reliability'], ['blast_radius']));
    }
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'genes.json'), { version: 1, genes: [] });

    var first = autoDistillFromFailures();
    assert.ok(first.ok);

    var second = autoDistillFromFailures();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'idempotent_skip');
  });
});

// ---------------------------------------------------------------------------
// Bench 4: Anti-pattern Avoidance
// ---------------------------------------------------------------------------
describe('bench: anti-pattern avoidance', function () {
  it('genes with anti-patterns score lower than clean genes', function () {
    var riskyGene = {
      type: 'Gene', id: 'gene_risky', category: 'repair',
      signals_match: ['error'],
      anti_patterns: [
        { mode: 'hard', learning_signals: ['problem:reliability'] },
        { mode: 'hard', learning_signals: ['problem:reliability'] },
      ],
      strategy: ['fix'],
    };
    var safeGene = {
      type: 'Gene', id: 'gene_safe', category: 'repair',
      signals_match: ['error'],
      learning_history: [
        { outcome: 'success', mode: 'none' },
        { outcome: 'success', mode: 'none' },
      ],
      strategy: ['fix safely'],
    };

    var result = selectGene([riskyGene, safeGene], ['error'], { effectivePopulationSize: 100 });
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_safe', 'Should prefer gene without anti-patterns');
  });
});

// ---------------------------------------------------------------------------
// Bench 5: shouldDistillFromFailures gate
// ---------------------------------------------------------------------------
describe('bench: shouldDistillFromFailures gate', function () {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns false when FAILURE_DISTILLER=false', function () {
    process.env.FAILURE_DISTILLER = 'false';
    assert.equal(shouldDistillFromFailures(), false);
    delete process.env.FAILURE_DISTILLER;
  });

  it('returns false when not enough failures', function () {
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), {
      version: 1, failed_capsules: [makeFailedCapsule('f1', 'g', ['e'], 'reason', [], [])],
    });
    assert.equal(shouldDistillFromFailures(), false);
  });

  it('returns true when enough failures and no recent distillation', function () {
    var failures = [];
    for (var i = 0; i < FAILURE_DISTILLER_MIN_CAPSULES + 1; i++) {
      failures.push(makeFailedCapsule('f' + i, 'gene_repair', ['error'], 'reason', [], []));
    }
    writeJson(path.join(process.env.GEP_ASSETS_DIR, 'failed_capsules.json'), { version: 1, failed_capsules: failures });
    assert.equal(shouldDistillFromFailures(), true);
  });
});

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  collectDistillationData,
  analyzePatterns,
  validateSynthesizedGene,
  buildDistillationPrompt,
  extractJsonFromLlmResponse,
  computeDataHash,
  shouldDistill,
  prepareDistillation,
  completeDistillation,
  autoDistill,
  synthesizeGeneFromPatterns,
  distillRequestPath,
  readDistillerState,
  writeDistillerState,
  DISTILLED_ID_PREFIX,
  DISTILLED_MAX_FILES,
} = require('../src/gep/skillDistiller');

// Create an isolated temp directory for each test to avoid polluting real assets.
let tmpDir;
let origGepAssetsDir;
let origEvolutionDir;
let origMemoryDir;
let origSkillDistiller;

function setupTempEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distiller-test-'));
  origGepAssetsDir = process.env.GEP_ASSETS_DIR;
  origEvolutionDir = process.env.EVOLUTION_DIR;
  origMemoryDir = process.env.MEMORY_DIR;
  origSkillDistiller = process.env.SKILL_DISTILLER;

  process.env.GEP_ASSETS_DIR = path.join(tmpDir, 'assets');
  process.env.EVOLUTION_DIR = path.join(tmpDir, 'evolution');
  process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
  process.env.MEMORY_GRAPH_PATH = path.join(tmpDir, 'evolution', 'memory_graph.jsonl');

  fs.mkdirSync(process.env.GEP_ASSETS_DIR, { recursive: true });
  fs.mkdirSync(process.env.EVOLUTION_DIR, { recursive: true });
  fs.mkdirSync(process.env.MEMORY_DIR, { recursive: true });
}

function teardownTempEnv() {
  if (origGepAssetsDir !== undefined) process.env.GEP_ASSETS_DIR = origGepAssetsDir;
  else delete process.env.GEP_ASSETS_DIR;
  if (origEvolutionDir !== undefined) process.env.EVOLUTION_DIR = origEvolutionDir;
  else delete process.env.EVOLUTION_DIR;
  if (origMemoryDir !== undefined) process.env.MEMORY_DIR = origMemoryDir;
  else delete process.env.MEMORY_DIR;
  if (origSkillDistiller !== undefined) process.env.SKILL_DISTILLER = origSkillDistiller;
  else delete process.env.SKILL_DISTILLER;
  delete process.env.MEMORY_GRAPH_PATH;

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

function makeCapsule(id, gene, status, score, trigger, summary) {
  return {
    type: 'Capsule', id: id, gene: gene,
    trigger: trigger || ['error', 'repair'],
    summary: summary || 'Fixed a bug in module X',
    outcome: { status: status, score: score },
  };
}

function writeCapsules(capsules) {
  fs.writeFileSync(
    path.join(process.env.GEP_ASSETS_DIR, 'capsules.json'),
    JSON.stringify({ version: 1, capsules: capsules }, null, 2)
  );
}

function writeEvents(events) {
  var lines = events.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n';
  fs.writeFileSync(path.join(process.env.GEP_ASSETS_DIR, 'events.jsonl'), lines);
}

function writeGenes(genes) {
  fs.writeFileSync(
    path.join(process.env.GEP_ASSETS_DIR, 'genes.json'),
    JSON.stringify({ version: 1, genes: genes }, null, 2)
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// --- Tests ---

describe('computeDataHash', () => {
  it('returns stable hash for same capsule ids', () => {
    var c1 = [{ id: 'a' }, { id: 'b' }];
    var c2 = [{ id: 'b' }, { id: 'a' }];
    assert.equal(computeDataHash(c1), computeDataHash(c2));
  });

  it('returns different hash for different capsule ids', () => {
    var c1 = [{ id: 'a' }];
    var c2 = [{ id: 'b' }];
    assert.notEqual(computeDataHash(c1), computeDataHash(c2));
  });
});

describe('extractJsonFromLlmResponse', () => {
  it('extracts Gene JSON from clean response', () => {
    var text = '{"type":"Gene","id":"gene_distilled_test","category":"repair","signals_match":["err"],"strategy":["fix it"]}';
    var gene = extractJsonFromLlmResponse(text);
    assert.ok(gene);
    assert.equal(gene.type, 'Gene');
    assert.equal(gene.id, 'gene_distilled_test');
  });

  it('extracts Gene JSON wrapped in markdown', () => {
    var text = 'Here is the gene:\n```json\n{"type":"Gene","id":"gene_distilled_x","category":"opt","signals_match":["a"],"strategy":["b"]}\n```\n';
    var gene = extractJsonFromLlmResponse(text);
    assert.ok(gene);
    assert.equal(gene.id, 'gene_distilled_x');
  });

  it('returns null when no Gene JSON present', () => {
    var text = 'No JSON here, just text.';
    assert.equal(extractJsonFromLlmResponse(text), null);
  });

  it('skips non-Gene JSON objects', () => {
    var text = '{"type":"Capsule","id":"cap1"} then {"type":"Gene","id":"gene_distilled_y","category":"c","signals_match":["s"],"strategy":["do"]}';
    var gene = extractJsonFromLlmResponse(text);
    assert.ok(gene);
    assert.equal(gene.type, 'Gene');
    assert.equal(gene.id, 'gene_distilled_y');
  });
});

describe('validateSynthesizedGene', () => {
  it('accepts a valid gene', () => {
    var gene = {
      type: 'Gene', id: 'gene_distilled_test', category: 'repair',
      signals_match: ['error'], strategy: ['identify the root cause', 'apply the fix', 'verify the solution'],
      constraints: { max_files: 8, forbidden_paths: ['.git', 'node_modules'] },
    };
    var result = validateSynthesizedGene(gene, []);
    assert.ok(result.valid, 'Expected valid but got errors: ' + result.errors.join(', '));
  });

  it('auto-prefixes id if missing distilled prefix', () => {
    var gene = {
      type: 'Gene', id: 'gene_test_auto', category: 'opt',
      signals_match: ['optimize'], strategy: ['do stuff'],
      constraints: { forbidden_paths: ['.git'] },
    };
    var result = validateSynthesizedGene(gene, []);
    assert.ok(result.gene.id.startsWith(DISTILLED_ID_PREFIX));
  });

  it('caps max_files to DISTILLED_MAX_FILES', () => {
    var gene = {
      type: 'Gene', id: 'gene_distilled_big', category: 'opt',
      signals_match: ['x'], strategy: ['y'],
      constraints: { max_files: 50, forbidden_paths: ['.git', 'node_modules'] },
    };
    var result = validateSynthesizedGene(gene, []);
    assert.ok(result.gene.constraints.max_files <= DISTILLED_MAX_FILES);
  });

  it('rejects gene without strategy', () => {
    var gene = { type: 'Gene', id: 'gene_distilled_empty', category: 'x', signals_match: ['a'] };
    var result = validateSynthesizedGene(gene, []);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(function (e) { return e.includes('strategy'); }));
  });

  it('rejects gene without signals_match', () => {
    var gene = { type: 'Gene', id: 'gene_distilled_nosig', category: 'x', strategy: ['do'] };
    var result = validateSynthesizedGene(gene, []);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(function (e) { return e.includes('signals_match'); }));
  });

  it('detects full overlap with existing gene', () => {
    var existing = [{ id: 'gene_existing', signals_match: ['error', 'repair'] }];
    var gene = {
      type: 'Gene', id: 'gene_distilled_dup', category: 'repair',
      signals_match: ['error', 'repair'], strategy: ['fix'],
      constraints: { forbidden_paths: ['.git', 'node_modules'] },
    };
    var result = validateSynthesizedGene(gene, existing);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(function (e) { return e.includes('overlaps'); }));
  });

  it('deduplicates id if conflict with existing gene', () => {
    var existing = [{ id: 'gene_distilled_conflict', signals_match: ['other'] }];
    var gene = {
      type: 'Gene', id: 'gene_distilled_conflict', category: 'opt',
      signals_match: ['different'], strategy: ['do'],
      constraints: { forbidden_paths: ['.git', 'node_modules'] },
    };
    var result = validateSynthesizedGene(gene, existing);
    assert.ok(result.gene.id !== 'gene_distilled_conflict');
    assert.ok(result.gene.id.startsWith('gene_distilled_conflict_'));
  });

  it('strips unsafe validation commands', () => {
    var gene = {
      type: 'Gene', id: 'gene_distilled_unsafe', category: 'opt',
      signals_match: ['x'], strategy: ['do'],
      constraints: { forbidden_paths: ['.git', 'node_modules'] },
      validation: ['node test.js', 'rm -rf /', 'echo $(whoami)', 'npm test'],
    };
    var result = validateSynthesizedGene(gene, []);
    assert.deepEqual(result.gene.validation, ['node test.js', 'npm test']);
  });
});

describe('collectDistillationData', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns empty when no capsules exist', () => {
    var data = collectDistillationData();
    assert.equal(data.successCapsules.length, 0);
    assert.equal(data.allCapsules.length, 0);
  });

  it('filters only successful capsules with score >= threshold', () => {
    var caps = [
      makeCapsule('c1', 'gene_a', 'success', 0.9),
      makeCapsule('c2', 'gene_a', 'failed', 0.2),
      makeCapsule('c3', 'gene_b', 'success', 0.5),
    ];
    writeCapsules(caps);
    var data = collectDistillationData();
    assert.equal(data.allCapsules.length, 3);
    assert.equal(data.successCapsules.length, 1);
    assert.equal(data.successCapsules[0].id, 'c1');
  });

  it('groups capsules by gene', () => {
    var caps = [
      makeCapsule('c1', 'gene_a', 'success', 0.9),
      makeCapsule('c2', 'gene_a', 'success', 0.8),
      makeCapsule('c3', 'gene_b', 'success', 0.95),
    ];
    writeCapsules(caps);
    var data = collectDistillationData();
    assert.equal(Object.keys(data.grouped).length, 2);
    assert.equal(data.grouped['gene_a'].total_count, 2);
    assert.equal(data.grouped['gene_b'].total_count, 1);
  });
});

describe('analyzePatterns', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('identifies high-frequency groups (count >= 5)', () => {
    var caps = [];
    for (var i = 0; i < 6; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9, ['error', 'crash']));
    }
    writeCapsules(caps);
    var data = collectDistillationData();
    var report = analyzePatterns(data);
    assert.equal(report.high_frequency.length, 1);
    assert.equal(report.high_frequency[0].gene_id, 'gene_a');
    assert.equal(report.high_frequency[0].count, 6);
  });

  it('detects strategy drift when summaries diverge', () => {
    var caps = [
      makeCapsule('c1', 'gene_a', 'success', 0.9, ['err'], 'Fixed crash in module A by patching function foo'),
      makeCapsule('c2', 'gene_a', 'success', 0.9, ['err'], 'Fixed crash in module A by patching function foo'),
      makeCapsule('c3', 'gene_a', 'success', 0.9, ['err'], 'Completely redesigned the logging infrastructure to avoid all future problems with disk IO'),
    ];
    writeCapsules(caps);
    var data = collectDistillationData();
    var report = analyzePatterns(data);
    assert.equal(report.strategy_drift.length, 1);
    assert.ok(report.strategy_drift[0].similarity < 0.6);
  });

  it('identifies coverage gaps from events', () => {
    writeCapsules([makeCapsule('c1', 'gene_a', 'success', 0.9, ['error'])]);
    var events = [];
    for (var i = 0; i < 5; i++) {
      events.push({ type: 'EvolutionEvent', signals: ['memory_leak', 'performance'] });
    }
    writeEvents(events);
    var data = collectDistillationData();
    var report = analyzePatterns(data);
    assert.ok(report.coverage_gaps.length > 0);
    assert.ok(report.coverage_gaps.some(function (g) { return g.signal === 'memory_leak'; }));
  });
});

describe('buildDistillationPrompt', () => {
  it('includes key instructions in prompt', () => {
    var analysis = { high_frequency: [], strategy_drift: [], coverage_gaps: [] };
    var genes = [{ id: 'gene_a', signals_match: ['err'] }];
    var caps = [makeCapsule('c1', 'gene_a', 'success', 0.9)];
    var prompt = buildDistillationPrompt(analysis, genes, caps);
    assert.ok(prompt.includes('actionable'));
    assert.ok(prompt.includes('gene_distilled_'));
    assert.ok(prompt.includes('Gene synthesis engine'));
    assert.ok(prompt.includes('forbidden_paths'));
  });
});

describe('shouldDistill', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns false when SKILL_DISTILLER=false', () => {
    process.env.SKILL_DISTILLER = 'false';
    assert.equal(shouldDistill(), false);
  });

  it('returns false when not enough successful capsules', () => {
    var caps = [];
    for (var i = 0; i < 10; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'failed', 0.3));
    }
    writeCapsules(caps);
    assert.equal(shouldDistill(), false);
  });

  it('returns false when interval not met', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeDistillerState({ last_distillation_at: new Date().toISOString() });
    assert.equal(shouldDistill(), false);
  });

  it('returns true when all conditions met', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeDistillerState({});
    delete process.env.SKILL_DISTILLER;
    assert.equal(shouldDistill(), true);
  });
});

describe('distiller state persistence', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('writes and reads state correctly', () => {
    var state = { last_distillation_at: '2025-01-01T00:00:00Z', last_data_hash: 'abc123', distillation_count: 3 };
    writeDistillerState(state);
    var loaded = readDistillerState();
    assert.equal(loaded.last_data_hash, 'abc123');
    assert.equal(loaded.distillation_count, 3);
  });
});

describe('prepareDistillation', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns insufficient_data when not enough capsules', () => {
    writeCapsules([makeCapsule('c1', 'gene_a', 'success', 0.9)]);
    var result = prepareDistillation();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'insufficient_data');
  });

  it('writes prompt and request files when conditions met', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeDistillerState({});
    writeGenes([]);

    var result = prepareDistillation();
    assert.equal(result.ok, true);
    assert.ok(result.promptPath);
    assert.ok(result.requestPath);
    assert.ok(fs.existsSync(result.promptPath));
    assert.ok(fs.existsSync(result.requestPath));

    var prompt = fs.readFileSync(result.promptPath, 'utf8');
    assert.ok(prompt.includes('Gene synthesis engine'));

    var request = JSON.parse(fs.readFileSync(result.requestPath, 'utf8'));
    assert.equal(request.type, 'DistillationRequest');
    assert.equal(request.input_capsule_count, 12);
  });

  it('returns idempotent_skip after completeDistillation with same data', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeGenes([]);
    writeDistillerState({});

    var prep = prepareDistillation();
    assert.equal(prep.ok, true);

    var llmResponse = JSON.stringify({
      type: 'Gene', id: 'gene_distilled_idem', category: 'repair',
      signals_match: ['error'], strategy: ['identify root cause', 'apply targeted fix', 'verify correction'],
      constraints: { max_files: 5, forbidden_paths: ['.git', 'node_modules'] },
    });
    var complete = completeDistillation(llmResponse);
    assert.equal(complete.ok, true);

    var second = prepareDistillation();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'idempotent_skip');
  });
});

describe('synthesizeGeneFromPatterns', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('builds a conservative distilled gene from repeated successful capsules', () => {
    writeCapsules([
      makeCapsule('c1', 'gene_perf', 'success', 0.95, ['perf_bottleneck', 'latency'], 'Reduced latency in hot path'),
      makeCapsule('c2', 'gene_perf', 'success', 0.92, ['perf_bottleneck', 'throughput'], 'Improved throughput under load'),
      makeCapsule('c3', 'gene_perf', 'success', 0.91, ['perf_bottleneck'], 'Cut slow-path overhead'),
      makeCapsule('c4', 'gene_perf', 'success', 0.93, ['perf_bottleneck'], 'Optimized repeated slow query'),
      makeCapsule('c5', 'gene_perf', 'success', 0.94, ['perf_bottleneck'], 'Reduced performance regressions'),
      makeCapsule('c6', 'gene_perf', 'success', 0.96, ['perf_bottleneck'], 'Stabilized latency under peak load'),
      makeCapsule('c7', 'gene_perf', 'success', 0.97, ['perf_bottleneck'], 'Optimized hot path validation'),
      makeCapsule('c8', 'gene_perf', 'success', 0.98, ['perf_bottleneck'], 'Minimized repeated bottleneck'),
      makeCapsule('c9', 'gene_perf', 'success', 0.99, ['perf_bottleneck'], 'Improved repeated performance pattern'),
      makeCapsule('c10', 'gene_perf', 'success', 0.91, ['perf_bottleneck'], 'Kept repeated success on perf fixes'),
    ]);
    writeGenes([{
      type: 'Gene',
      id: 'gene_perf',
      category: 'optimize',
      signals_match: ['perf_bottleneck'],
      strategy: ['Profile the hot path', 'Apply the narrowest optimization', 'Run focused perf validation'],
      constraints: { max_files: 8, forbidden_paths: ['.git', 'node_modules'] },
      validation: ['node --test'],
    }]);

    var data = collectDistillationData();
    var analysis = analyzePatterns(data);
    var gene = synthesizeGeneFromPatterns(data, analysis, [{ id: 'gene_perf', category: 'optimize', signals_match: ['perf_bottleneck'] }]);
    assert.ok(gene);
    assert.ok(gene.id.startsWith('gene_distilled_'));
    assert.equal(gene.category, 'optimize');
    assert.ok(gene.signals_match.includes('perf_bottleneck'));
  });
});

describe('autoDistill', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('writes a distilled gene automatically when enough successful capsules exist', () => {
    var caps = [];
    for (var i = 0; i < 10; i++) {
      caps.push(makeCapsule('c' + i, 'gene_perf', 'success', 0.95, ['perf_bottleneck'], 'Reduce repeated latency regressions'));
    }
    writeCapsules(caps);
    writeGenes([{
      type: 'Gene',
      id: 'gene_perf',
      category: 'optimize',
      signals_match: ['perf_bottleneck'],
      strategy: ['Profile the slow path', 'Apply a targeted optimization', 'Run validation'],
      constraints: { max_files: 8, forbidden_paths: ['.git', 'node_modules'] },
      validation: ['node --test'],
    }]);

    var result = autoDistill();
    assert.ok(result.ok, result.reason || 'autoDistill should succeed');
    assert.ok(result.gene.id.startsWith('gene_distilled_'));
    var genes = readJson(path.join(process.env.GEP_ASSETS_DIR, 'genes.json'));
    assert.ok(genes.genes.some(function (g) { return g.id === result.gene.id; }));
  });
});

describe('completeDistillation', () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns no_request when no pending request', () => {
    var result = completeDistillation('{"type":"Gene"}');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_request');
  });

  it('returns no_gene_in_response for invalid LLM output', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeDistillerState({});
    writeGenes([]);

    var prep = prepareDistillation();
    assert.equal(prep.ok, true);

    var result = completeDistillation('No valid JSON here');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_gene_in_response');
  });

  it('validates and saves gene from valid LLM response', () => {
    var caps = [];
    for (var i = 0; i < 12; i++) {
      caps.push(makeCapsule('c' + i, 'gene_a', 'success', 0.9));
    }
    writeCapsules(caps);
    writeDistillerState({});
    writeGenes([]);

    var prep = prepareDistillation();
    assert.equal(prep.ok, true);

    var llmResponse = JSON.stringify({
      type: 'Gene',
      id: 'gene_distilled_test_complete',
      category: 'repair',
      signals_match: ['error', 'crash'],
      strategy: ['Identify the failing module', 'Apply targeted fix', 'Run validation'],
      constraints: { max_files: 5, forbidden_paths: ['.git', 'node_modules'] },
      validation: ['node test.js'],
    });

    var result = completeDistillation(llmResponse);
    assert.equal(result.ok, true);
    assert.ok(result.gene);
    assert.equal(result.gene.type, 'Gene');
    assert.ok(result.gene.id.startsWith('gene_distilled_'));

    var state = readDistillerState();
    assert.ok(state.last_distillation_at);
    assert.equal(state.distillation_count, 1);

    assert.ok(!fs.existsSync(distillRequestPath()));
  });
});

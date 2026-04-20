'use strict';
// Integration tests: file locking in assetStore (H3)
// Verifies that concurrent writes don't lose data.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Swap GEP_ASSETS_DIR to a temp dir for isolation
let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-lock-test-'));
  process.env.GEP_ASSETS_DIR = tmpDir;
});

after(() => {
  delete process.env.GEP_ASSETS_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('withFileLock — basic acquisition', () => {
  it('acquires and releases a lock', () => {
    const { withFileLock } = require('../../src/gep/assetStore');
    const target = path.join(tmpDir, 'test.json');
    fs.writeFileSync(target, '{}');
    let ran = false;
    withFileLock(target, () => { ran = true; });
    assert.ok(ran);
    // Lock file should be removed after release
    assert.ok(!fs.existsSync(target + '.lock'), 'lock file should be cleaned up');
  });

  it('does not leave lock file on exception inside fn', () => {
    const { withFileLock } = require('../../src/gep/assetStore');
    const target = path.join(tmpDir, 'test2.json');
    fs.writeFileSync(target, '{}');
    assert.throws(() => {
      withFileLock(target, () => { throw new Error('inner error'); });
    }, /inner error/);
    assert.ok(!fs.existsSync(target + '.lock'), 'lock file must be released even on throw');
  });
});

describe('upsertGene — no data loss under sequential writes', () => {
  it('accumulates multiple genes without overwriting', () => {
    const { upsertGene, loadGenes } = require('../../src/gep/assetStore');
    const gene1 = { type: 'Gene', id: 'test_gene_1', category: 'repair', signals_match: ['error'] };
    const gene2 = { type: 'Gene', id: 'test_gene_2', category: 'optimize', signals_match: ['perf'] };
    const gene3 = { type: 'Gene', id: 'test_gene_3', category: 'innovate', signals_match: ['feature'] };
    upsertGene(gene1);
    upsertGene(gene2);
    upsertGene(gene3);
    const genes = loadGenes();
    const ids = genes.map(g => g.id);
    assert.ok(ids.includes('test_gene_1'), 'gene1 must be present');
    assert.ok(ids.includes('test_gene_2'), 'gene2 must be present');
    assert.ok(ids.includes('test_gene_3'), 'gene3 must be present');
  });

  it('upsert overwrites existing gene by id', () => {
    const { upsertGene, loadGenes } = require('../../src/gep/assetStore');
    const original = { type: 'Gene', id: 'test_upsert', category: 'repair', signals_match: ['a'] };
    const updated  = { type: 'Gene', id: 'test_upsert', category: 'optimize', signals_match: ['b'] };
    upsertGene(original);
    upsertGene(updated);
    const genes = loadGenes();
    const found = genes.filter(g => g.id === 'test_upsert');
    assert.strictEqual(found.length, 1, 'should not duplicate');
    assert.strictEqual(found[0].category, 'optimize');
  });
});

describe('appendCapsule — data integrity', () => {
  it('appends multiple capsules without loss', () => {
    const { appendCapsule, loadCapsules } = require('../../src/gep/assetStore');
    const c1 = { type: 'Capsule', id: 'cap_test_1', content: 'first' };
    const c2 = { type: 'Capsule', id: 'cap_test_2', content: 'second' };
    appendCapsule(c1);
    appendCapsule(c2);
    const caps = loadCapsules();
    const ids = caps.map(c => c.id);
    assert.ok(ids.includes('cap_test_1'));
    assert.ok(ids.includes('cap_test_2'));
  });
});

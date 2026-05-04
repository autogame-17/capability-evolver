// Regression guard for #519: memory_graph.jsonl must rotate once it
// exceeds EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB so long-running nodes don't
// accumulate multi-GB append-only files. The rotation is gzip'd and
// retention-limited.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

describe('memoryGraph rotation (#519)', () => {
  let tmpDir;
  const savedEnv = {};
  const envKeys = [
    'EVOLVER_MEMORY_GRAPH_AUTO_ROTATE',
    'EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB',
    'EVOLVER_MEMORY_GRAPH_RETENTION_COUNT',
    'MEMORY_GRAPH_PATH',
    'MEMORY_DIR',
    'EVOLUTION_DIR',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-rotate-'));
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MEMORY_GRAPH_PATH = path.join(tmpDir, 'memory_graph.jsonl');
    process.env.EVOLUTION_DIR = tmpDir;
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rotates when active file exceeds max size', () => {
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '0.01'; // 10 KB
    const activePath = process.env.MEMORY_GRAPH_PATH;

    // Require the module BEFORE creating the oversized file so the
    // startup-rotation pass in module init doesn't pre-empt the explicit
    // maybeRotateMemoryGraph() call we want to exercise here.
    const mg = freshRequire('../src/gep/memoryGraph');
    fs.writeFileSync(activePath, 'x'.repeat(20 * 1024)); // 20 KB
    const renamed = mg.maybeRotateMemoryGraph(activePath, { force: true });

    assert.ok(renamed, 'expected rotation to return the archive path');
    assert.ok(!fs.existsSync(activePath) || fs.statSync(activePath).size === 0,
      'active file should be absent or empty after rotation');

    const archives = fs.readdirSync(tmpDir).filter(n => /memory_graph\.jsonl\.\d+/.test(n));
    assert.ok(archives.length >= 1, 'expected at least one rotated archive');
    const gz = archives.find(n => n.endsWith('.gz'));
    assert.ok(gz, 'expected archive to be gzip-compressed');
    const decoded = zlib.gunzipSync(fs.readFileSync(path.join(tmpDir, gz)));
    assert.equal(decoded.length, 20 * 1024, 'decoded archive should match original content size');
  });

  it('rotates oversized file at module startup', () => {
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '0.01'; // 10 KB
    const activePath = process.env.MEMORY_GRAPH_PATH;
    fs.writeFileSync(activePath, 'x'.repeat(20 * 1024)); // 20 KB pre-existing oversized file

    freshRequire('../src/gep/memoryGraph');

    assert.ok(!fs.existsSync(activePath) || fs.statSync(activePath).size === 0,
      'active file should be rotated away at startup');
    const archives = fs.readdirSync(tmpDir).filter(n => /memory_graph\.jsonl\.\d+/.test(n));
    assert.ok(archives.length >= 1, 'startup rotation should produce at least one archive');
  });

  it('does not rotate when file is below threshold', () => {
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '100';
    const activePath = process.env.MEMORY_GRAPH_PATH;
    fs.writeFileSync(activePath, 'x'.repeat(1024));

    const mg = freshRequire('../src/gep/memoryGraph');
    const renamed = mg.maybeRotateMemoryGraph(activePath, { force: true });

    assert.equal(renamed, null, 'rotation should not trigger under threshold');
    assert.ok(fs.existsSync(activePath), 'active file should still exist');
    const archives = fs.readdirSync(tmpDir).filter(n => /memory_graph\.jsonl\.\d+/.test(n));
    assert.equal(archives.length, 0, 'no archives should be produced');
  });

  it('respects EVOLVER_MEMORY_GRAPH_AUTO_ROTATE=false opt-out', () => {
    process.env.EVOLVER_MEMORY_GRAPH_AUTO_ROTATE = 'false';
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '0.001';
    const activePath = process.env.MEMORY_GRAPH_PATH;

    const mg = freshRequire('../src/gep/memoryGraph');
    fs.writeFileSync(activePath, 'x'.repeat(10 * 1024));
    const renamed = mg.maybeRotateMemoryGraph(activePath, { force: true });

    assert.equal(renamed, null, 'opt-out must skip rotation');
    assert.ok(fs.existsSync(activePath), 'file should remain untouched');
  });

  it('prunes rotated archives beyond retention count', () => {
    process.env.EVOLVER_MEMORY_GRAPH_RETENTION_COUNT = '2';
    const activePath = process.env.MEMORY_GRAPH_PATH;
    const tsList = ['20260401000000', '20260402000000', '20260403000000', '20260404000000', '20260405000000'];
    for (const ts of tsList) {
      fs.writeFileSync(path.join(tmpDir, `memory_graph.jsonl.${ts}.gz`), 'archive');
    }

    const mg = freshRequire('../src/gep/memoryGraph');
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '0.001';
    fs.writeFileSync(activePath, 'x'.repeat(10 * 1024));
    mg.maybeRotateMemoryGraph(activePath, { force: true });

    const archives = fs.readdirSync(tmpDir)
      .filter(n => /memory_graph\.jsonl\.\d+/.test(n))
      .sort();
    assert.equal(archives.length, 2, 'only retention_count newest archives should remain');
  });

  it('exposes config helpers that read current env', () => {
    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '42';
    process.env.EVOLVER_MEMORY_GRAPH_RETENTION_COUNT = '3';
    const mg = freshRequire('../src/gep/memoryGraph');
    assert.equal(mg.rotationMaxSizeBytes(), 42 * 1024 * 1024);
    assert.equal(mg.rotationRetentionCount(), 3);
    assert.equal(mg.rotationEnabled(), true);
  });

  it('uses sane defaults when env vars are absent or invalid', () => {
    const mg = freshRequire('../src/gep/memoryGraph');
    assert.equal(mg.rotationMaxSizeBytes(), 100 * 1024 * 1024);
    assert.equal(mg.rotationRetentionCount(), 7);

    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = 'not-a-number';
    process.env.EVOLVER_MEMORY_GRAPH_RETENTION_COUNT = '-1';
    const mg2 = freshRequire('../src/gep/memoryGraph');
    assert.equal(mg2.rotationMaxSizeBytes(), 100 * 1024 * 1024, 'invalid MB falls back to default');
    assert.equal(mg2.rotationRetentionCount(), 7, 'negative retention falls back to default');
  });

  it('accepts 0 as retention (delete all archives)', () => {
    process.env.EVOLVER_MEMORY_GRAPH_RETENTION_COUNT = '0';
    const mg = freshRequire('../src/gep/memoryGraph');
    assert.equal(mg.rotationRetentionCount(), 0);

    const activePath = process.env.MEMORY_GRAPH_PATH;
    fs.writeFileSync(path.join(tmpDir, 'memory_graph.jsonl.20260401000000.gz'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'memory_graph.jsonl.20260402000000.gz'), 'b');

    process.env.EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB = '0.001';
    fs.writeFileSync(activePath, 'x'.repeat(10 * 1024));
    mg.maybeRotateMemoryGraph(activePath, { force: true });

    const archives = fs.readdirSync(tmpDir).filter(n => /memory_graph\.jsonl\.\d+/.test(n));
    assert.equal(archives.length, 0, 'retention=0 should delete every archive including the just-rotated one');
  });
});

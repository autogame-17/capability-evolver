const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { exportGepx } = require('../src/gep/portable');

function mkTmpAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-portable-'));
  const assetsDir = path.join(root, 'assets', 'gep');
  const memDir = path.join(root, 'memory');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(memDir, { recursive: true });

  fs.writeFileSync(
    path.join(assetsDir, 'genes.json'),
    JSON.stringify({ version: 1, genes: [{ id: 'gene_a', summary: 'test a' }, { id: 'gene_b' }] }, null, 2)
  );
  fs.writeFileSync(
    path.join(assetsDir, 'capsules.json'),
    JSON.stringify({ version: 1, capsules: [{ id: 'caps_a', summary: 'c' }] }, null, 2)
  );
  fs.writeFileSync(
    path.join(assetsDir, 'events.jsonl'),
    JSON.stringify({ ts: 'x', kind: 'k' }) + '\n' + JSON.stringify({ ts: 'y', kind: 'z' }) + '\n'
  );
  fs.writeFileSync(
    path.join(memDir, 'memory_graph.jsonl'),
    JSON.stringify({ node: 'm1' }) + '\n'
  );
  return { root, assetsDir, memoryGraphPath: path.join(memDir, 'memory_graph.jsonl') };
}

describe('portable.exportGepx', () => {
  it('creates a gzip tar with manifest, checksum and expected contents', () => {
    const { root, assetsDir, memoryGraphPath } = mkTmpAssets();
    const outputPath = path.join(root, 'bundle.gepx');

    const result = exportGepx({
      assetsDir,
      memoryGraphPath,
      outputPath,
      agentId: 'node-test',
      agentName: 'tester',
    });

    assert.equal(result.outputPath, outputPath);
    assert.ok(fs.existsSync(outputPath), '.gepx archive should exist');
    assert.equal(result.manifest.statistics.total_genes, 2);
    assert.equal(result.manifest.statistics.total_capsules, 1);
    assert.equal(result.manifest.statistics.total_events, 2);
    assert.equal(result.manifest.statistics.memory_graph_entries, 1);
    assert.equal(result.manifest.agent_id, 'node-test');

    const extractDir = path.join(root, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', outputPath, '-C', extractDir]);

    assert.ok(fs.existsSync(path.join(extractDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(extractDir, 'checksum.sha256')));
    assert.ok(fs.existsSync(path.join(extractDir, 'genes', 'genes.json')));
    assert.ok(fs.existsSync(path.join(extractDir, 'capsules', 'capsules.json')));
    assert.ok(fs.existsSync(path.join(extractDir, 'events', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(extractDir, 'memory', 'memory_graph.jsonl')));

    const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source.platform, 'evolver');
    assert.equal(manifest.source.component, 'sync');
    assert.ok(manifest.created_at, 'manifest.created_at must be set');

    const checksums = fs.readFileSync(path.join(extractDir, 'checksum.sha256'), 'utf8');
    assert.match(checksums, /genes\/genes\.json/);
    assert.match(checksums, /capsules\/capsules\.json/);
  });

  it('works without a memory graph file', () => {
    const { root, assetsDir } = mkTmpAssets();
    const outputPath = path.join(root, 'bundle-no-mem.gepx');
    const bogusMem = path.join(root, 'does-not-exist', 'memory_graph.jsonl');

    const result = exportGepx({
      assetsDir,
      memoryGraphPath: bogusMem,
      outputPath,
      agentId: 'node-test',
    });
    assert.ok(fs.existsSync(outputPath));
    assert.equal(result.manifest.statistics.memory_graph_entries, 0);
  });

  it('rejects missing assetsDir', () => {
    assert.throws(
      () => exportGepx({ outputPath: '/tmp/out.gepx' }),
      /assetsDir required/
    );
  });

  it('rejects missing outputPath', () => {
    assert.throws(
      () => exportGepx({ assetsDir: '/tmp/a' }),
      /outputPath required/
    );
  });

  it('is idempotent: running twice produces a valid archive each time', () => {
    const { root, assetsDir, memoryGraphPath } = mkTmpAssets();
    const outputPath = path.join(root, 'idem.gepx');
    const r1 = exportGepx({ assetsDir, memoryGraphPath, outputPath, agentId: 'n' });
    const r2 = exportGepx({ assetsDir, memoryGraphPath, outputPath, agentId: 'n' });
    assert.equal(r1.manifest.statistics.total_genes, r2.manifest.statistics.total_genes);
    assert.ok(fs.existsSync(outputPath));
  });
});

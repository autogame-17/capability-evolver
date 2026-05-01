// Portable .gepx archive export (CommonJS).
// Mirrors @evomap/gep-sdk exportGepx semantics: gzip-tar the local GEP assets
// (genes / capsules / events / memory graph) plus a manifest and sha256
// checksums so the archive is self-describing.
//
// Kept intentionally minimal (no import path): evolver sync uses this to bundle
// "everything locally known about this agent" so a user can hand the single
// file to another machine or keep a point-in-time snapshot.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim()).length;
}

function countJsonItems(filePath, key) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data[key]) ? data[key].length : 0;
  } catch {
    return 0;
  }
}

function exportGepx({ assetsDir, memoryGraphPath, outputPath, agentId, agentName }) {
  if (!assetsDir) throw new Error('exportGepx: assetsDir required');
  if (!outputPath) throw new Error('exportGepx: outputPath required');

  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = `${outputPath}.tmp`;
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, 'genes'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'capsules'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });

  const filesToCopy = [
    { src: path.join(assetsDir, 'genes.json'), dest: path.join(tmpDir, 'genes', 'genes.json') },
    { src: path.join(assetsDir, 'genes.jsonl'), dest: path.join(tmpDir, 'genes', 'genes.jsonl') },
    { src: path.join(assetsDir, 'capsules.json'), dest: path.join(tmpDir, 'capsules', 'capsules.json') },
    { src: path.join(assetsDir, 'capsules.jsonl'), dest: path.join(tmpDir, 'capsules', 'capsules.jsonl') },
    { src: path.join(assetsDir, 'events.jsonl'), dest: path.join(tmpDir, 'events', 'events.jsonl') },
  ];
  if (memoryGraphPath) {
    filesToCopy.push({ src: memoryGraphPath, dest: path.join(tmpDir, 'memory', 'memory_graph.jsonl') });
  }

  const checksums = [];
  for (const f of filesToCopy) {
    if (!fs.existsSync(f.src)) continue;
    const content = fs.readFileSync(f.src);
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    fs.writeFileSync(f.dest, content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    checksums.push(`${hash}  ${path.relative(tmpDir, f.dest)}`);
  }

  const stats = {
    total_events: countJsonlLines(path.join(tmpDir, 'events', 'events.jsonl')),
    total_genes: countJsonItems(path.join(tmpDir, 'genes', 'genes.json'), 'genes'),
    total_capsules: countJsonItems(path.join(tmpDir, 'capsules', 'capsules.json'), 'capsules'),
    memory_graph_entries: memoryGraphPath
      ? countJsonlLines(path.join(tmpDir, 'memory', 'memory_graph.jsonl'))
      : 0,
  };

  const manifest = {
    gep_version: '1.0.0',
    created_at: new Date().toISOString(),
    agent_id: agentId || null,
    agent_name: agentName || 'unknown',
    statistics: stats,
    source: { platform: 'evolver', component: 'sync' },
  };

  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(tmpDir, 'checksum.sha256'), checksums.join('\n') + '\n');

  try {
    execFileSync('tar', ['-czf', outputPath, '-C', tmpDir, '.'], { timeout: 60000 });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`tar failed: ${err.message}. Ensure tar is available on your system.`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return { outputPath, manifest };
}

module.exports = { exportGepx };

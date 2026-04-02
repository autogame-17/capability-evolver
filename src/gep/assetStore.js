const fs = require('fs');
const path = require('path');
const { getGepAssetsDir } = require('./paths');
const { computeAssetId, SCHEMA_VERSION } = require('./contentHash');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[AssetStore] Failed to read ${filePath}:`, e && e.message || e);
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function buildValidationCmd(relModules) {
  const paths = relModules.map(m => `./${m}`);
  return `node scripts/validate-modules.js ${paths.join(' ')}`;
}

function getDefaultGenes() {
  return {
    version: 1,
    genes: [
      {
        type: 'Gene', id: 'gene_gep_repair_from_errors', category: 'repair',
        signals_match: ['error', 'exception', 'failed', 'unstable'],
        preconditions: ['signals contains error-related indicators'],
        strategy: [
          'Extract structured signals from logs and user instructions',
          'Select an existing Gene by signals match (no improvisation)',
          'Estimate blast radius (files, lines) before editing',
          'Apply smallest reversible patch',
          'Validate using declared validation steps; rollback on failure',
          'Solidify knowledge: append EvolutionEvent, update Gene/Capsule store',
        ],
        constraints: { max_files: 12, forbidden_paths: ['.git', 'node_modules'] },
        validation: [
          buildValidationCmd(['src/evolve', 'src/gep/solidify', 'src/gep/policyCheck', 'src/gep/selector', 'src/gep/memoryGraph', 'src/gep/assetStore']),
          'node scripts/validate-suite.js',
        ],
      },
      {
        type: 'Gene', id: 'gene_gep_optimize_prompt_and_assets', category: 'optimize',
        signals_match: ['protocol', 'gep', 'prompt', 'audit', 'reusable'],
        preconditions: ['need stricter, auditable evolution protocol outputs'],
        strategy: [
          'Extract signals and determine selection rationale via Selector JSON',
          'Prefer reusing existing Gene/Capsule; only create if no match exists',
          'Refactor prompt assembly to embed assets (genes, capsules, parent event)',
          'Reduce noise and ambiguity; enforce strict output schema',
          'Validate by running node index.js run and ensuring no runtime errors',
          'Solidify: record EvolutionEvent, update Gene definitions, create Capsule on success',
        ],
        constraints: { max_files: 20, forbidden_paths: ['.git', 'node_modules'] },
        validation: [
          buildValidationCmd(['src/evolve', 'src/gep/prompt', 'src/gep/contentHash', 'src/gep/skillDistiller']),
          'node scripts/validate-suite.js',
        ],
      },
      {
        type: 'Gene', id: 'gene_tool_integrity', category: 'repair',
        signals_match: ['tool_bypass'],
        preconditions: ['agent used shell/exec to perform an action that a registered tool can handle'],
        strategy: [
          'Always prefer registered tools over ad-hoc scripts or shell workarounds',
          'If a registered tool fails, report the actual error honestly and attempt to fix the root cause',
          'Never fabricate explanations -- describe actual actions transparently',
          'Do not create temporary scripts in extension or project directories',
        ],
        constraints: { max_files: 4, forbidden_paths: ['.git', 'node_modules'] },
        validation: [
          'node scripts/validate-suite.js',
        ],
        anti_patterns: ['tool_bypass'],
      },
    ],
  };
}

function getDefaultCapsules() { return { version: 1, capsules: [] }; }
function genesPath() { return path.join(getGepAssetsDir(), 'genes.json'); }
function capsulesPath() { return path.join(getGepAssetsDir(), 'capsules.json'); }
function capsulesJsonlPath() { return path.join(getGepAssetsDir(), 'capsules.jsonl'); }
function eventsPath() { return path.join(getGepAssetsDir(), 'events.jsonl'); }
function candidatesPath() { return path.join(getGepAssetsDir(), 'candidates.jsonl'); }
function externalCandidatesPath() { return path.join(getGepAssetsDir(), 'external_candidates.jsonl'); }
function failedCapsulesPath() { return path.join(getGepAssetsDir(), 'failed_capsules.json'); }

function loadGenes() {
  const jsonGenes = readJsonIfExists(genesPath(), getDefaultGenes()).genes || [];
  const jsonlGenes = [];
  try {
    const p = path.join(getGepAssetsDir(), 'genes.jsonl');
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      raw.split('\n').forEach(line => {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.type === 'Gene') jsonlGenes.push(parsed);
          } catch(e) {}
        }
      });
    }
  } catch(e) {
    console.warn(`[AssetStore] Failed to read genes.jsonl:`, e && e.message || e);
  }

  const combined = [...jsonGenes, ...jsonlGenes];
  const unique = new Map();
  combined.forEach(g => {
    if (g && g.id) unique.set(String(g.id), g);
  });
  return Array.from(unique.values());
}

function loadCapsules() {
  const legacy = readJsonIfExists(capsulesPath(), getDefaultCapsules()).capsules || [];
  const jsonlCapsules = [];
  try {
    const p = capsulesJsonlPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      raw.split('\n').forEach(line => {
        if (line.trim()) {
            try { jsonlCapsules.push(JSON.parse(line)); } catch(e) {}
        }
      });
    }
  } catch(e) {
    console.warn(`[AssetStore] Failed to read capsules.jsonl:`, e && e.message || e);
  }
  const combined = [...legacy, ...jsonlCapsules];
  const unique = new Map();
  combined.forEach(c => {
    if (c && c.id) unique.set(String(c.id), c);
  });
  return Array.from(unique.values());
}
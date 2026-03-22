'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const learningSignals = require('./learningSignals');

const DISTILLER_MIN_CAPSULES = parseInt(process.env.DISTILLER_MIN_CAPSULES || '10', 10) || 10;
const DISTILLER_INTERVAL_HOURS = parseInt(process.env.DISTILLER_INTERVAL_HOURS || '24', 10) || 24;
const DISTILLER_MIN_SUCCESS_RATE = parseFloat(process.env.DISTILLER_MIN_SUCCESS_RATE || '0.7') || 0.7;
const DISTILLED_MAX_FILES = 12;
const DISTILLED_ID_PREFIX = 'gene_distilled_';

const FAILURE_DISTILLER_MIN_CAPSULES = parseInt(process.env.FAILURE_DISTILLER_MIN_CAPSULES || '5', 10) || 5;
const FAILURE_DISTILLER_INTERVAL_HOURS = parseInt(process.env.FAILURE_DISTILLER_INTERVAL_HOURS || '12', 10) || 12;
const REPAIR_DISTILLED_ID_PREFIX = 'gene_repair_distilled_';

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
    return fallback;
  }
}

function readJsonlIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function distillerLogPath() {
  return path.join(paths.getMemoryDir(), 'distiller_log.jsonl');
}

function distillerStatePath() {
  return path.join(paths.getMemoryDir(), 'distiller_state.json');
}

function readDistillerState() {
  return readJsonIfExists(distillerStatePath(), {});
}

function writeDistillerState(state) {
  ensureDir(path.dirname(distillerStatePath()));
  const tmp = distillerStatePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, distillerStatePath());
}

function computeDataHash(capsules) {
  const ids = capsules.map(function (c) { return c.id || ''; }).sort();
  return crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Step 1: collectDistillationData
// ---------------------------------------------------------------------------
function collectDistillationData() {
  const assetsDir = paths.getGepAssetsDir();
  const evoDir = paths.getEvolutionDir();

  const capsulesJson = readJsonIfExists(path.join(assetsDir, 'capsules.json'), { capsules: [] });
  const capsulesJsonl = readJsonlIfExists(path.join(assetsDir, 'capsules.jsonl'));
  let allCapsules = [].concat(capsulesJson.capsules || [], capsulesJsonl);

  const unique = new Map();
  allCapsules.forEach(function (c) { if (c && c.id) unique.set(String(c.id), c); });
  allCapsules = Array.from(unique.values());

  const successCapsules = allCapsules.filter(function (c) {
    if (!c || !c.outcome) return false;
    const status = typeof c.outcome === 'string' ? c.outcome : c.outcome.status;
    if (status !== 'success') return false;
    const score = c.outcome && Number.isFinite(Number(c.outcome.score)) ? Number(c.outcome.score) : 1;
    return score >= DISTILLER_MIN_SUCCESS_RATE;
  });

  const events = readJsonlIfExists(path.join(assetsDir, 'events.jsonl'));

  const memGraphPath = process.env.MEMORY_GRAPH_PATH || path.join(evoDir, 'memory_graph.jsonl');
  const graphEntries = readJsonlIfExists(memGraphPath);

  const grouped = {};
  successCapsules.forEach(function (c) {
    const geneId = c.gene || c.gene_id || 'unknown';
    if (!grouped[geneId]) {
      grouped[geneId] = {
        gene_id: geneId, capsules: [], total_count: 0,
        total_score: 0, triggers: [], summaries: [],
      };
    }
    const g = grouped[geneId];
    g.capsules.push(c);
    g.total_count += 1;
    g.total_score += (c.outcome && Number.isFinite(Number(c.outcome.score))) ? Number(c.outcome.score) : 0.8;
    if (Array.isArray(c.trigger)) g.triggers.push(c.trigger);
    if (c.summary) g.summaries.push(String(c.summary));
  });

  Object.keys(grouped).forEach(function (id) {
    const g = grouped[id];
    g.avg_score = g.total_count > 0 ? g.total_score / g.total_count : 0;
  });

  return {
    successCapsules: successCapsules,
    allCapsules: allCapsules,
    events: events,
    graphEntries: graphEntries,
    grouped: grouped,
    dataHash: computeDataHash(successCapsules),
  };
}

// ---------------------------------------------------------------------------
// Step 2: analyzePatterns
// ---------------------------------------------------------------------------
function analyzePatterns(data) {
  const grouped = data.grouped;
  const report = {
    high_frequency: [],
    strategy_drift: [],
    coverage_gaps: [],
    total_success: data.successCapsules.length,
    total_capsules: data.allCapsules.length,
    success_rate: data.allCapsules.length > 0 ? data.successCapsules.length / data.allCapsules.length : 0,
  };

  Object.keys(grouped).forEach(function (geneId) {
    const g = grouped[geneId];
    if (g.total_count >= 5) {
      let flat = [];
      g.triggers.forEach(function (t) { if (Array.isArray(t)) flat = flat.concat(t); });
      const freq = {};
      flat.forEach(function (t) { const k = String(t).toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
      const top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 5);
      report.high_frequency.push({ gene_id: geneId, count: g.total_count, avg_score: Math.round(g.avg_score * 100) / 100, top_triggers: top });
    }

    if (g.summaries.length >= 3) {
      const first = g.summaries[0];
      const last = g.summaries[g.summaries.length - 1];
      if (first !== last) {
        const fw = new Set(first.toLowerCase().split(/\s+/));
        const lw = new Set(last.toLowerCase().split(/\s+/));
        let inter = 0;
        fw.forEach(function (w) { if (lw.has(w)) inter++; });
        const union = fw.size + lw.size - inter;
        const sim = union > 0 ? inter / union : 1;
        if (sim < 0.6) {
          report.strategy_drift.push({ gene_id: geneId, similarity: Math.round(sim * 100) / 100, early_summary: first.slice(0, 120), recent_summary: last.slice(0, 120) });
        }
      }
    }
  });

  const signalFreq = {};
  (data.events || []).forEach(function (evt) {
    if (evt && Array.isArray(evt.signals)) {
      evt.signals.forEach(function (s) { const k = String(s).toLowerCase(); signalFreq[k] = (signalFreq[k] || 0) + 1; });
    }
  });
  const covered = new Set();
  Object.keys(grouped).forEach(function (geneId) {
    grouped[geneId].triggers.forEach(function (t) {
      if (Array.isArray(t)) t.forEach(function (s) { covered.add(String(s).toLowerCase()); });
    });
  });
  const gaps = Object.keys(signalFreq)
    .filter(function (s) { return signalFreq[s] >= 3 && !covered.has(s); })
    .sort(function (a, b) { return signalFreq[b] - signalFreq[a]; })
    .slice(0, 10);
  if (gaps.length > 0) {
    report.coverage_gaps = gaps.map(function (s) { return { signal: s, frequency: signalFreq[s] }; });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Step 3: LLM response parsing
// ---------------------------------------------------------------------------
function extractJsonFromLlmResponse(text) {
  const str = String(text || '');
  let buffer = '';
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') { if (depth === 0) buffer = ''; depth++; buffer += ch; }
    else if (ch === '}') {
      depth--; buffer += ch;
      if (depth === 0 && buffer.length > 2) {
        try { const obj = JSON.parse(buffer); if (obj && typeof obj === 'object' && obj.type === 'Gene') return obj; } catch (e) {}
        buffer = '';
      }
      if (depth < 0) depth = 0;
    } else if (depth > 0) { buffer += ch; }
  }
  return null;
}

function buildDistillationPrompt(analysis, existingGenes, sampleCapsules) {
  const genesRef = existingGenes.map(function (g) {
    return { id: g.id, category: g.category || null, signals_match: g.signals_match || [] };
  });
  const samples = sampleCapsules.slice(0, 8).map(function (c) {
    return { gene: c.gene || c.gene_id || null, trigger: c.trigger || [], summary: (c.summary || '').slice(0, 200), outcome: c.outcome || null };
  });

  return [
    'You are a Gene synthesis engine for the GEP (Genome Evolution Protocol).',
    'Your job is to distill successful evolution capsules into a high-quality, reusable Gene',
    'that other AI agents can discover, fetch, and execute.',
    '',
    '## OUTPUT FORMAT',
    '',
    'Output ONLY a single valid JSON object (no markdown fences, no explanation).',
    '',
    '## GENE ID RULES (CRITICAL)',
    '',
    '- The id MUST start with "' + DISTILLED_ID_PREFIX + '" followed by a descriptive kebab-case name.',
    '- The suffix MUST describe the core capability in 3-6 hyphen-separated words.',
    '- NEVER include timestamps, numeric IDs, random numbers, tool names (cursor, vscode, etc.), or UUIDs.',
    '- Good: "gene_distilled_retry-with-exponential-backoff", "gene_distilled_database-migration-rollback"',
    '- Bad: "gene_distilled_cursor-1773331925711", "gene_distilled_1234567890", "gene_distilled_fix-1"',
    '',
    '## SUMMARY RULES',
    '',
    '- The "summary" MUST be a clear, human-readable sentence (30-200 chars) describing',
    '  WHAT capability this Gene provides and WHY it is useful.',
    '- Write as if for a marketplace listing -- the summary is the first thing other agents see.',
    '- Good: "Retry failed HTTP requests with exponential backoff, jitter, and circuit breaker to prevent cascade failures"',
    '- Bad: "Distilled from capsules", "AI agent skill", "cursor automation", "1773331925711"',
    '- NEVER include timestamps, build numbers, or tool names in the summary.',
    '',
    '## SIGNALS_MATCH RULES',
    '',
    '- Each signal MUST be a generic, reusable keyword that describes WHEN to trigger this Gene.',
    '- Use lowercase_snake_case. Signals should be domain terms, not implementation artifacts.',
    '- NEVER include timestamps, build numbers, tool names, session IDs, or random suffixes.',
    '- Include 3-7 signals covering both the problem domain and the solution approach.',
    '- Good: ["http_retry", "request_timeout", "exponential_backoff", "circuit_breaker", "resilience"]',
    '- Bad: ["cursor_auto_1773331925711", "cli_headless_1773331925711", "bypass_123"]',
    '',
    '## STRATEGY RULES',
    '',
    '- Strategy steps MUST be actionable, concrete instructions an AI agent can execute.',
    '- Each step should be a clear imperative sentence starting with a verb.',
    '- Include 5-10 steps. Each step should be self-contained and specific.',
    '- Do NOT describe what happened; describe what TO DO.',
    '- Include rationale or context in parentheses when non-obvious.',
    '- Where applicable, include inline code examples using backtick notation.',
    '- Good: "Wrap the HTTP call in a retry loop with `maxRetries=3` and initial delay of 500ms"',
    '- Bad: "Handle retries", "Fix the issue", "Improve reliability"',
    '',
    '## PRECONDITIONS RULES',
    '',
    '- List concrete, verifiable conditions that must be true before applying this Gene.',
    '- Each precondition should be a testable statement, not a vague requirement.',
    '- Good: "Project uses Node.js >= 18 with ES module support"',
    '- Bad: "need to fix something"',
    '',
    '## CONSTRAINTS',
    '',
    '- constraints.max_files MUST be <= ' + DISTILLED_MAX_FILES,
    '- constraints.forbidden_paths MUST include at least [".git", "node_modules"]',
    '',
    '## VALIDATION',
    '',
    '- Validation commands MUST start with "node ", "npm ", or "npx " (security constraint).',
    '- Include commands that actually verify the Gene was applied correctly.',
    '- Good: "npx tsc --noEmit", "npm test"',
    '- Bad: "node -v" (proves nothing about the Gene)',
    '',
    '## QUALITY BAR',
    '',
    'Imagine this Gene will be published on a marketplace for thousands of AI agents.',
    'It should be as professional and useful as a well-written library README.',
    'Ask yourself: "Would another agent find this Gene by searching for the signals?',
    'Would the summary make them want to fetch it? Would the strategy be enough to execute?"',
    '',
    '---',
    '',
    'SUCCESSFUL CAPSULES (grouped by pattern):',
    JSON.stringify(samples, null, 2),
    '',
    'EXISTING GENES (avoid duplication):',
    JSON.stringify(genesRef, null, 2),
    '',
    'ANALYSIS:',
    JSON.stringify(analysis, null, 2),
    '',
    'Output a single Gene JSON object with these fields:',
    '{ "type": "Gene", "id": "gene_distilled_<descriptive-kebab-name>", "summary": "<clear marketplace-quality description>", "category": "repair|optimize|innovate", "signals_match": ["generic_signal_1", ...], "preconditions": ["Concrete condition 1", ...], "strategy": ["Step 1: verb ...", "Step 2: verb ...", ...], "constraints": { "max_files": N, "forbidden_paths": [".git", "node_modules", ...] }, "validation": ["npx tsc --noEmit", ...], "schema_version": "1.6.0" }',
  ].join('\n');
}

function distillRequestPath() {
  return path.join(paths.getMemoryDir(), 'distill_request.json');
}

// ---------------------------------------------------------------------------
// Derive a descriptive ID from gene content when the LLM gives a bad name
// ---------------------------------------------------------------------------
function deriveDescriptiveId(gene) {
  let words = [];
  if (Array.isArray(gene.signals_match)) {
    gene.signals_match.slice(0, 3).forEach(function (s) {
      String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).forEach(function (w) {
        if (w.length >= 3 && words.length < 6) words.push(w);
      });
    });
  }
  if (words.length < 3 && gene.summary) {
    const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'are', 'was', 'has', 'had']);
    String(gene.summary).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).forEach(function (w) {
      if (w.length >= 3 && !STOP.has(w) && words.length < 6) words.push(w);
    });
  }
  if (words.length < 3 && Array.isArray(gene.strategy) && gene.strategy.length > 0) {
    String(gene.strategy[0]).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).forEach(function (w) {
      if (w.length >= 3 && words.length < 6) words.push(w);
    });
  }
  if (words.length < 2) words = ['auto', 'distilled', 'strategy'];
  const unique = [];
  const seen = new Set();
  words.forEach(function (w) { if (!seen.has(w)) { seen.add(w); unique.push(w); } });
  return DISTILLED_ID_PREFIX + unique.slice(0, 5).join('-');
}

// ---------------------------------------------------------------------------
// Step 4: sanitizeSignalsMatch -- strip timestamps, random suffixes, tool names
// ---------------------------------------------------------------------------
function sanitizeSignalsMatch(signals) {
  if (!Array.isArray(signals)) return [];
  const cleaned = [];
  signals.forEach(function (s) {
    let sig = String(s || '').trim().toLowerCase();
    if (!sig) return;
    // Strip trailing timestamps (10+ digits) and random suffixes
    sig = sig.replace(/[_-]\d{10,}$/g, '');
    // Strip leading/trailing underscores/hyphens left over
    sig = sig.replace(/^[_-]+|[_-]+$/g, '');
    // Reject signals that are purely numeric
    if (/^\d+$/.test(sig)) return;
    // Reject signals that are just a tool name with optional number
    if (/^(cursor|vscode|vim|emacs|windsurf|copilot|cline|codex|bypass|distill)[_-]?\d*$/i.test(sig)) return;
    // Reject signals shorter than 3 chars after cleaning
    if (sig.length < 3) return;
    // Reject signals that still contain long numeric sequences (session IDs, etc.)
    if (/\d{8,}/.test(sig)) return;
    cleaned.push(sig);
  });
  // Deduplicate
  const seen = {};
  return cleaned.filter(function (s) { if (seen[s]) return false; seen[s] = true; return true; });
}

// ---------------------------------------------------------------------------
// Step 4: validateSynthesizedGene
// ---------------------------------------------------------------------------
function validateSynthesizedGene(gene, existingGenes) {
  const errors = [];
  if (!gene || typeof gene !== 'object') return { valid: false, errors: ['gene is not an object'] };

  if (gene.type !== 'Gene') errors.push('missing or wrong type (must be "Gene")');
  if (!gene.id || typeof gene.id !== 'string') errors.push('missing id');
  if (!gene.category) errors.push('missing category');
  if (!Array.isArray(gene.signals_match) || gene.signals_match.length === 0) errors.push('missing or empty signals_match');
  if (!Array.isArray(gene.strategy) || gene.strategy.length === 0) errors.push('missing or empty strategy');

  // --- Signals sanitization (BEFORE id derivation so deriveDescriptiveId uses clean signals) ---
  if (Array.isArray(gene.signals_match)) {
    gene.signals_match = sanitizeSignalsMatch(gene.signals_match);
    if (gene.signals_match.length === 0) {
      errors.push('signals_match is empty after sanitization (all signals were invalid)');
    }
  }

  // --- Summary sanitization (BEFORE id derivation so deriveDescriptiveId uses clean summary) ---
  if (gene.summary) {
    gene.summary = gene.summary.replace(/\s*\d{10,}\s*$/g, '').replace(/\.\s*\d{10,}/g, '.').trim();
  }

  // --- ID sanitization ---
  if (gene.id && !String(gene.id).startsWith(DISTILLED_ID_PREFIX)) {
    gene.id = DISTILLED_ID_PREFIX + String(gene.id).replace(/^gene_/, '');
  }

  if (gene.id) {
    let suffix = String(gene.id).replace(DISTILLED_ID_PREFIX, '');
    suffix = suffix.replace(/[-_]?\d{10,}[-_]?/g, '-').replace(/[-_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    const needsRename = /^\d+$/.test(suffix) || /^\d{10,}/.test(suffix)
      || /^(cursor|vscode|vim|emacs|windsurf|copilot|cline|codex)[-_]?\d*$/i.test(suffix);
    if (needsRename) {
      gene.id = deriveDescriptiveId(gene);
    } else {
      gene.id = DISTILLED_ID_PREFIX + suffix;
    }
    const cleanSuffix = String(gene.id).replace(DISTILLED_ID_PREFIX, '');
    if (cleanSuffix.replace(/[-_]/g, '').length < 6) {
      gene.id = deriveDescriptiveId(gene);
    }
  }

  // --- Summary fallback (summary was already sanitized above, this handles missing/short) ---
  if (!gene.summary || typeof gene.summary !== 'string' || gene.summary.length < 10) {
    if (Array.isArray(gene.strategy) && gene.strategy.length > 0) {
      gene.summary = String(gene.strategy[0]).slice(0, 200);
    } else if (Array.isArray(gene.signals_match) && gene.signals_match.length > 0) {
      gene.summary = 'Strategy for: ' + gene.signals_match.slice(0, 3).join(', ');
    }
  }

  // --- Strategy quality: require minimum 3 steps ---
  if (Array.isArray(gene.strategy) && gene.strategy.length < 3) {
    errors.push('strategy must have at least 3 steps for a quality skill');
  }

  // --- Constraints ---
  if (!gene.constraints || typeof gene.constraints !== 'object') gene.constraints = {};
  if (!Array.isArray(gene.constraints.forbidden_paths) || gene.constraints.forbidden_paths.length === 0) {
    gene.constraints.forbidden_paths = ['.git', 'node_modules'];
  }
  if (!gene.constraints.forbidden_paths.some(function (p) { return p === '.git' || p === 'node_modules'; })) {
    errors.push('constraints.forbidden_paths must include .git or node_modules');
  }
  if (!gene.constraints.max_files || gene.constraints.max_files > DISTILLED_MAX_FILES) {
    gene.constraints.max_files = DISTILLED_MAX_FILES;
  }

  // --- Validation command sanitization ---
  const ALLOWED_PREFIXES = ['node ', 'npm ', 'npx '];
  if (Array.isArray(gene.validation)) {
    gene.validation = gene.validation.filter(function (cmd) {
      const c = String(cmd || '').trim();
      if (!c) return false;
      if (!ALLOWED_PREFIXES.some(function (p) { return c.startsWith(p); })) return false;
      if (/`|\$\(/.test(c)) return false;
      const stripped = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
      return !/[;&|><]/.test(stripped);
    });
  }

  // --- Schema version ---
  if (!gene.schema_version) gene.schema_version = '1.6.0';

  // --- Duplicate ID check ---
  const existingIds = new Set((existingGenes || []).map(function (g) { return g.id; }));
  if (gene.id && existingIds.has(gene.id)) {
    gene.id = gene.id + '_' + Date.now().toString(36);
  }

  // --- Signal overlap check ---
  if (gene.signals_match && existingGenes && existingGenes.length > 0) {
    const newSet = new Set(gene.signals_match.map(function (s) { return String(s).toLowerCase(); }));
    for (let i = 0; i < existingGenes.length; i++) {
      const eg = existingGenes[i];
      const egSet = new Set((eg.signals_match || []).map(function (s) { return String(s).toLowerCase(); }));
      if (newSet.size > 0 && egSet.size > 0) {
        let overlap = 0;
        newSet.forEach(function (s) { if (egSet.has(s)) overlap++; });
        if (overlap === newSet.size && overlap === egSet.size) {
          errors.push('signals_match fully overlaps with existing gene: ' + eg.id);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors: errors, gene: gene };
}

// ---------------------------------------------------------------------------
// shouldDistill: gate check
// ---------------------------------------------------------------------------
function shouldDistill() {
  if (String(process.env.SKILL_DISTILLER || 'true').toLowerCase() === 'false') return false;

  const state = readDistillerState();
  if (state.last_distillation_at) {
    const elapsed = Date.now() - new Date(state.last_distillation_at).getTime();
    if (elapsed < DISTILLER_INTERVAL_HOURS * 3600000) return false;
  }

  const assetsDir = paths.getGepAssetsDir();
  const capsulesJson = readJsonIfExists(path.join(assetsDir, 'capsules.json'), { capsules: [] });
  const capsulesJsonl = readJsonlIfExists(path.join(assetsDir, 'capsules.jsonl'));
  const all = [].concat(capsulesJson.capsules || [], capsulesJsonl);

  const recent = all.slice(-10);
  const recentSuccess = recent.filter(function (c) {
    return c && c.outcome && (c.outcome.status === 'success' || c.outcome === 'success');
  }).length;
  if (recentSuccess < 7) return false;

  const totalSuccess = all.filter(function (c) {
    return c && c.outcome && (c.outcome.status === 'success' || c.outcome === 'success');
  }).length;
  if (totalSuccess < DISTILLER_MIN_CAPSULES) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Step 5a: prepareDistillation -- collect data, build prompt, write to file
// ---------------------------------------------------------------------------
function prepareDistillation() {
  console.log('[Distiller] Preparing skill distillation...');

  const data = collectDistillationData();
  console.log('[Distiller] Collected ' + data.successCapsules.length + ' successful capsules across ' + Object.keys(data.grouped).length + ' gene groups.');

  if (data.successCapsules.length < DISTILLER_MIN_CAPSULES) {
    console.log('[Distiller] Not enough successful capsules (' + data.successCapsules.length + ' < ' + DISTILLER_MIN_CAPSULES + '). Skipping.');
    return { ok: false, reason: 'insufficient_data' };
  }

  const state = readDistillerState();
  if (state.last_data_hash === data.dataHash) {
    console.log('[Distiller] Data unchanged since last distillation (hash: ' + data.dataHash + '). Skipping.');
    return { ok: false, reason: 'idempotent_skip' };
  }

  const analysis = analyzePatterns(data);
  console.log('[Distiller] Analysis: high_freq=' + analysis.high_frequency.length + ' drift=' + analysis.strategy_drift.length + ' gaps=' + analysis.coverage_gaps.length);

  const assetsDir = paths.getGepAssetsDir();
  const existingGenesJson = readJsonIfExists(path.join(assetsDir, 'genes.json'), { genes: [] });
  const existingGenes = existingGenesJson.genes || [];

  const prompt = buildDistillationPrompt(analysis, existingGenes, data.successCapsules);

  const memDir = paths.getMemoryDir();
  ensureDir(memDir);
  const promptFileName = 'distill_prompt_' + Date.now() + '.txt';
  const promptPath = path.join(memDir, promptFileName);
  fs.writeFileSync(promptPath, prompt, 'utf8');

  const reqPath = distillRequestPath();
  const requestData = {
    type: 'DistillationRequest',
    created_at: new Date().toISOString(),
    prompt_path: promptPath,
    data_hash: data.dataHash,
    input_capsule_count: data.successCapsules.length,
    analysis_summary: {
      high_frequency_count: analysis.high_frequency.length,
      drift_count: analysis.strategy_drift.length,
      gap_count: analysis.coverage_gaps.length,
      success_rate: Math.round(analysis.success_rate * 100) / 100,
    },
  };
  fs.writeFileSync(reqPath, JSON.stringify(requestData, null, 2) + '\n', 'utf8');

  console.log('[Distiller] Prompt written to: ' + promptPath);
  return { ok: true, promptPath: promptPath, requestPath: reqPath, dataHash: data.dataHash };
}

function inferCategoryFromSignals(signals) {
  const list = Array.isArray(signals) ? signals.map(function (s) { return String(s).toLowerCase(); }) : [];
  if (list.some(function (s) { return s.indexOf('error') !== -1 || s.indexOf('fail') !== -1 || s.indexOf('reliability') !== -1; })) {
    return 'repair';
  }
  if (list.some(function (s) { return s.indexOf('feature') !== -1 || s.indexOf('capability') !== -1 || s.indexOf('stagnation') !== -1; })) {
    return 'innovate';
  }
  return 'optimize';
}

function chooseDistillationSource(data, analysis) {
  const grouped = data && data.grouped ? data.grouped : {};
  let best = null;
  Object.keys(grouped).forEach(function (geneId) {
    const g = grouped[geneId];
    if (!g || g.total_count <= 0) return;
    const score = (g.total_count * 2) + (g.avg_score || 0);
    if (!best || score > best.score) {
      best = { gene_id: geneId, group: g, score: score };
    }
  });
  return best;
}

function synthesizeGeneFromPatterns(data, analysis, existingGenes) {
  const source = chooseDistillationSource(data, analysis);
  if (!source || !source.group) return null;

  const group = source.group;
  const existing = Array.isArray(existingGenes) ? existingGenes : [];
  const sourceGene = existing.find(function (g) { return g && g.id === source.gene_id; }) || null;

  const triggerFreq = {};
  (group.triggers || []).forEach(function (arr) {
    (Array.isArray(arr) ? arr : []).forEach(function (s) {
      const k = String(s).toLowerCase();
      triggerFreq[k] = (triggerFreq[k] || 0) + 1;
    });
  });
  let signalsMatch = Object.keys(triggerFreq)
    .sort(function (a, b) { return triggerFreq[b] - triggerFreq[a]; })
    .slice(0, 6);
  const summaryText = (group.summaries || []).slice(0, 5).join(' ');
  const derivedTags = learningSignals.expandSignals(signalsMatch, summaryText)
    .filter(function (tag) { return tag.indexOf('problem:') === 0 || tag.indexOf('area:') === 0; })
    .slice(0, 4);
  signalsMatch = Array.from(new Set(signalsMatch.concat(derivedTags)));
  if (signalsMatch.length === 0 && sourceGene && Array.isArray(sourceGene.signals_match)) {
    signalsMatch = sourceGene.signals_match.slice(0, 6);
  }

  const category = sourceGene && sourceGene.category ? sourceGene.category : inferCategoryFromSignals(signalsMatch);
  const idSeed = {
    type: 'Gene',
    id: DISTILLED_ID_PREFIX + source.gene_id.replace(/^gene_/, '').replace(/^gene_distilled_/, ''),
    category: category,
    signals_match: signalsMatch,
    strategy: sourceGene && Array.isArray(sourceGene.strategy) && sourceGene.strategy.length > 0
      ? sourceGene.strategy.slice(0, 4)
      : [
        'Identify the dominant repeated trigger pattern.',
        'Apply the smallest targeted change for that pattern.',
        'Run the narrowest validation that proves the regression is gone.',
        'Rollback immediately if validation fails.',
      ],
  };

  let summaryBase = (group.summaries && group.summaries[0]) ? String(group.summaries[0]) : '';
  if (!summaryBase) {
    summaryBase = 'Reusable strategy for repeated successful pattern: ' + signalsMatch.slice(0, 3).join(', ');
  }

  const gene = {
    type: 'Gene',
    id: deriveDescriptiveId(idSeed),
    summary: summaryBase.slice(0, 200),
    category: category,
    signals_match: signalsMatch,
    preconditions: sourceGene && Array.isArray(sourceGene.preconditions) && sourceGene.preconditions.length > 0
      ? sourceGene.preconditions.slice(0, 4)
      : ['repeated success pattern observed in recent capsules'],
    strategy: idSeed.strategy,
    constraints: {
      max_files: sourceGene && sourceGene.constraints && Number(sourceGene.constraints.max_files) > 0
        ? Math.min(DISTILLED_MAX_FILES, Number(sourceGene.constraints.max_files))
        : DISTILLED_MAX_FILES,
      forbidden_paths: sourceGene && sourceGene.constraints && Array.isArray(sourceGene.constraints.forbidden_paths)
        ? sourceGene.constraints.forbidden_paths.slice(0, 6)
        : ['.git', 'node_modules'],
    },
    validation: sourceGene && Array.isArray(sourceGene.validation) && sourceGene.validation.length > 0
      ? sourceGene.validation.slice(0, 4)
      : ['node --test'],
  };

  return gene;
}

function finalizeDistilledGene(gene, requestLike, status) {
  const state = readDistillerState();
  state.last_distillation_at = new Date().toISOString();
  state.last_data_hash = requestLike.data_hash;
  state.last_gene_id = gene.id;
  state.distillation_count = (state.distillation_count || 0) + 1;
  writeDistillerState(state);

  appendJsonl(distillerLogPath(), {
    timestamp: new Date().toISOString(),
    data_hash: requestLike.data_hash,
    input_capsule_count: requestLike.input_capsule_count,
    analysis_summary: requestLike.analysis_summary,
    synthesized_gene_id: gene.id,
    validation_passed: true,
    validation_errors: [],
    status: status || 'success',
    gene: gene,
  });
}

// ---------------------------------------------------------------------------
// Step 5b: completeDistillation -- validate LLM response and save gene
// ---------------------------------------------------------------------------
function completeDistillation(responseText) {
  const reqPath = distillRequestPath();
  const request = readJsonIfExists(reqPath, null);

  if (!request) {
    console.warn('[Distiller] No pending distillation request found.');
    return { ok: false, reason: 'no_request' };
  }

  const rawGene = extractJsonFromLlmResponse(responseText);
  if (!rawGene) {
    appendJsonl(distillerLogPath(), {
      timestamp: new Date().toISOString(),
      data_hash: request.data_hash,
      status: 'error',
      error: 'LLM response did not contain a valid Gene JSON',
    });
    console.error('[Distiller] LLM response did not contain a valid Gene JSON.');
    return { ok: false, reason: 'no_gene_in_response' };
  }

  const assetsDir = paths.getGepAssetsDir();
  const existingGenesJson = readJsonIfExists(path.join(assetsDir, 'genes.json'), { genes: [] });
  const existingGenes = existingGenesJson.genes || [];

  const validation = validateSynthesizedGene(rawGene, existingGenes);

  const logEntry = {
    timestamp: new Date().toISOString(),
    data_hash: request.data_hash,
    input_capsule_count: request.input_capsule_count,
    analysis_summary: request.analysis_summary,
    synthesized_gene_id: validation.gene ? validation.gene.id : null,
    validation_passed: validation.valid,
    validation_errors: validation.errors,
  };

  if (!validation.valid) {
    logEntry.status = 'validation_failed';
    appendJsonl(distillerLogPath(), logEntry);
    console.warn('[Distiller] Gene failed validation: ' + validation.errors.join(', '));
    return { ok: false, reason: 'validation_failed', errors: validation.errors };
  }

  const gene = validation.gene;
  gene._distilled_meta = {
    distilled_at: new Date().toISOString(),
    source_capsule_count: request.input_capsule_count,
    data_hash: request.data_hash,
  };

  const assetStore = require('./assetStore');
  assetStore.upsertGene(gene);
  console.log('[Distiller] Gene "' + gene.id + '" written to genes.json.');

  const state = readDistillerState();
  state.last_distillation_at = new Date().toISOString();
  state.last_data_hash = request.data_hash;
  state.last_gene_id = gene.id;
  state.distillation_count = (state.distillation_count || 0) + 1;
  writeDistillerState(state);

  logEntry.status = 'success';
  logEntry.gene = gene;
  appendJsonl(distillerLogPath(), logEntry);

  try { fs.unlinkSync(reqPath); } catch (e) {}
  try { if (request.prompt_path) fs.unlinkSync(request.prompt_path); } catch (e) {}

  console.log('[Distiller] Distillation complete. New gene: ' + gene.id);

  if (process.env.SKILL_AUTO_PUBLISH !== '0') {
    try {
      const skillPublisher = require('./skillPublisher');
      skillPublisher.publishSkillToHub(gene).then(function (res) {
        if (res.ok) {
          console.log('[Distiller] Skill published to Hub: ' + (res.result?.skill_id || gene.id));
        } else {
          console.warn('[Distiller] Skill publish failed: ' + (res.error || 'unknown'));
        }
      }).catch(function () {});
    } catch (e) {
      console.warn('[Distiller] Skill publisher unavailable: ' + e.message);
    }
  }

  return { ok: true, gene: gene };
}

function autoDistill() {
  const data = collectDistillationData();
  if (data.successCapsules.length < DISTILLER_MIN_CAPSULES) {
    return { ok: false, reason: 'insufficient_data' };
  }

  const state = readDistillerState();
  if (state.last_data_hash === data.dataHash) {
    return { ok: false, reason: 'idempotent_skip' };
  }

  const analysis = analyzePatterns(data);
  const assetsDir = paths.getGepAssetsDir();
  const existingGenesJson = readJsonIfExists(path.join(assetsDir, 'genes.json'), { genes: [] });
  const existingGenes = existingGenesJson.genes || [];
  const rawGene = synthesizeGeneFromPatterns(data, analysis, existingGenes);
  if (!rawGene) return { ok: false, reason: 'no_candidate_gene' };

  const validation = validateSynthesizedGene(rawGene, existingGenes);
  if (!validation.valid) {
    appendJsonl(distillerLogPath(), {
      timestamp: new Date().toISOString(),
      data_hash: data.dataHash,
      status: 'auto_validation_failed',
      synthesized_gene_id: validation.gene ? validation.gene.id : null,
      validation_errors: validation.errors,
    });
    return { ok: false, reason: 'validation_failed', errors: validation.errors };
  }

  const gene = validation.gene;
  gene._distilled_meta = {
    distilled_at: new Date().toISOString(),
    source_capsule_count: data.successCapsules.length,
    data_hash: data.dataHash,
    auto_distilled: true,
  };

  const assetStore = require('./assetStore');
  assetStore.upsertGene(gene);
  finalizeDistilledGene(gene, {
    data_hash: data.dataHash,
    input_capsule_count: data.successCapsules.length,
    analysis_summary: {
      high_frequency_count: analysis.high_frequency.length,
      drift_count: analysis.strategy_drift.length,
      gap_count: analysis.coverage_gaps.length,
      success_rate: Math.round(analysis.success_rate * 100) / 100,
    },
  }, 'auto_success');

  return { ok: true, gene: gene, auto: true };
}

// ---------------------------------------------------------------------------
// Failure-based distillation (inspired by MetaClaw's failure trajectory approach)
// ---------------------------------------------------------------------------

function collectFailureDistillationData() {
  const assetsDir = paths.getGepAssetsDir();
  const failedPath = path.join(assetsDir, 'failed_capsules.json');
  const failedData = readJsonIfExists(failedPath, { failed_capsules: [] });
  const failedCapsules = Array.isArray(failedData.failed_capsules) ? failedData.failed_capsules : [];

  if (failedCapsules.length === 0) return { failedCapsules: [], grouped: {}, dataHash: '' };

  const grouped = {};
  failedCapsules.forEach(function (c) {
    if (!c) return;
    const reasonClass = (c.failure_reason || '').split(':')[0].split(' ')[0].toLowerCase() || 'unknown';
    const geneId = c.gene || 'unknown';
    const key = geneId + '::' + reasonClass;
    if (!grouped[key]) {
      grouped[key] = {
        key: key,
        gene_id: geneId,
        reason_class: reasonClass,
        capsules: [],
        count: 0,
        triggers: [],
        failure_reasons: [],
        learning_signals_all: [],
        constraint_violations_all: [],
      };
    }
    const g = grouped[key];
    g.capsules.push(c);
    g.count += 1;
    if (Array.isArray(c.trigger)) g.triggers.push(c.trigger);
    if (c.failure_reason) g.failure_reasons.push(String(c.failure_reason).slice(0, 300));
    if (Array.isArray(c.learning_signals)) {
      g.learning_signals_all = g.learning_signals_all.concat(c.learning_signals);
    }
    if (Array.isArray(c.constraint_violations)) {
      g.constraint_violations_all = g.constraint_violations_all.concat(c.constraint_violations);
    }
  });

  return {
    failedCapsules: failedCapsules,
    grouped: grouped,
    dataHash: computeDataHash(failedCapsules),
  };
}

function analyzeFailurePatterns(data) {
  const grouped = data.grouped;
  const report = {
    high_frequency_failures: [],
    recurring_violations: [],
    total_failures: data.failedCapsules.length,
  };

  Object.keys(grouped).forEach(function (key) {
    var g = grouped[key];
    if (g.count >= 2) {
      var flat = [];
      g.triggers.forEach(function (t) { if (Array.isArray(t)) flat = flat.concat(t); });
      var freq = {};
      flat.forEach(function (t) { var k = String(t).toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
      var topTriggers = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 5);

      var violationFreq = {};
      g.constraint_violations_all.forEach(function (v) {
        var k = String(v).split(':')[0].toLowerCase();
        violationFreq[k] = (violationFreq[k] || 0) + 1;
      });
      var topViolations = Object.keys(violationFreq).sort(function (a, b) { return violationFreq[b] - violationFreq[a]; }).slice(0, 3);

      report.high_frequency_failures.push({
        key: key,
        gene_id: g.gene_id,
        reason_class: g.reason_class,
        count: g.count,
        top_triggers: topTriggers,
        top_violations: topViolations,
        sample_reasons: g.failure_reasons.slice(0, 3),
      });
    }
  });

  var allViolations = {};
  Object.keys(grouped).forEach(function (key) {
    grouped[key].constraint_violations_all.forEach(function (v) {
      var k = String(v).split(':')[0].toLowerCase();
      allViolations[k] = (allViolations[k] || 0) + 1;
    });
  });
  report.recurring_violations = Object.keys(allViolations)
    .filter(function (k) { return allViolations[k] >= 2; })
    .sort(function (a, b) { return allViolations[b] - allViolations[a]; })
    .slice(0, 8)
    .map(function (k) { return { violation: k, count: allViolations[k] }; });

  return report;
}

function buildFailureDistillationPrompt(analysis, existingGenes, sampleCapsules) {
  var genesRef = existingGenes.map(function (g) {
    return { id: g.id, category: g.category || null, signals_match: g.signals_match || [] };
  });
  var samples = sampleCapsules.slice(0, 8).map(function (c) {
    return {
      gene: c.gene || null,
      trigger: c.trigger || [],
      failure_reason: (c.failure_reason || '').slice(0, 300),
      learning_signals: (c.learning_signals || []).slice(0, 8),
      constraint_violations: (c.constraint_violations || []).slice(0, 5),
      blast_radius: c.blast_radius || null,
    };
  });

  return [
    'You are a Repair Gene synthesis engine for the GEP (Genome Evolution Protocol).',
    'Your job is to distill FAILED evolution capsules into a defensive, reusable Repair Gene',
    'that prevents other AI agents from repeating the same failure patterns.',
    '',
    '## CONTEXT',
    '',
    'These capsules represent failed evolution attempts. Your goal is to analyze the failure',
    'patterns and synthesize a Gene that, when matched, guides agents to AVOID the mistake',
    'and apply the correct approach instead.',
    '',
    '## OUTPUT FORMAT',
    '',
    'Output ONLY a single valid JSON object (no markdown fences, no explanation).',
    '',
    '## GENE ID RULES (CRITICAL)',
    '',
    '- The id MUST start with "' + REPAIR_DISTILLED_ID_PREFIX + '" followed by a descriptive kebab-case name.',
    '- The suffix MUST describe the failure pattern being guarded against in 3-6 words.',
    '- Good: "gene_repair_distilled_prevent-blast-radius-overflow", "gene_repair_distilled_validate-before-destructive-write"',
    '',
    '## SUMMARY RULES',
    '',
    '- The "summary" MUST describe WHAT failure pattern this Gene prevents and HOW.',
    '- Write defensively: "Prevents X by ensuring Y before Z".',
    '- Good: "Prevents blast radius overflow by pre-checking file count and running narrower patches"',
    '',
    '## STRATEGY RULES',
    '',
    '- Strategy steps MUST be defensive and preventive, not just reactive.',
    '- Include explicit guard checks, pre-validation, and rollback instructions.',
    '- Start with verification/guard steps, then the safe action, then validation.',
    '- Include 5-10 steps.',
    '',
    '## SIGNALS_MATCH RULES',
    '',
    '- Include signals that match the CONTEXT where this failure occurs.',
    '- Include both the triggering signals and the failure-type signals.',
    '- Good: ["blast_radius_exceeded", "constraint_violation", "error", "repair"]',
    '',
    '## CONSTRAINTS',
    '',
    '- constraints.max_files MUST be <= ' + DISTILLED_MAX_FILES,
    '- constraints.forbidden_paths MUST include at least [".git", "node_modules"]',
    '',
    '## VALIDATION',
    '',
    '- Validation commands MUST start with "node ", "npm ", or "npx " (security constraint).',
    '',
    '---',
    '',
    'FAILED CAPSULES (grouped by failure pattern):',
    JSON.stringify(samples, null, 2),
    '',
    'FAILURE ANALYSIS:',
    JSON.stringify(analysis, null, 2),
    '',
    'EXISTING GENES (avoid duplication):',
    JSON.stringify(genesRef, null, 2),
    '',
    'Output a single Gene JSON object:',
    '{ "type": "Gene", "id": "' + REPAIR_DISTILLED_ID_PREFIX + '<descriptive-kebab-name>", "summary": "<defensive description>", "category": "repair", "signals_match": ["signal_1", ...], "preconditions": ["condition 1", ...], "strategy": ["Step 1: guard ...", "Step 2: verify ...", ...], "constraints": { "max_files": N, "forbidden_paths": [".git", "node_modules", ...] }, "validation": ["npx tsc --noEmit", ...], "schema_version": "1.6.0" }',
  ].join('\n');
}

function synthesizeRepairGeneFromFailures(data, analysis, existingGenes) {
  if (!analysis || !analysis.high_frequency_failures || analysis.high_frequency_failures.length === 0) return null;

  var topPattern = analysis.high_frequency_failures[0];
  var existing = Array.isArray(existingGenes) ? existingGenes : [];

  var triggerFreq = {};
  var group = data.grouped[topPattern.key];
  if (!group) return null;

  (group.triggers || []).forEach(function (arr) {
    (Array.isArray(arr) ? arr : []).forEach(function (s) {
      var k = String(s).toLowerCase();
      triggerFreq[k] = (triggerFreq[k] || 0) + 1;
    });
  });

  var signalsMatch = Object.keys(triggerFreq)
    .sort(function (a, b) { return triggerFreq[b] - triggerFreq[a]; })
    .slice(0, 4);

  var failureSignals = [];
  (group.learning_signals_all || []).forEach(function (s) {
    var k = String(s).toLowerCase();
    if (failureSignals.indexOf(k) === -1 && failureSignals.length < 3) failureSignals.push(k);
  });
  signalsMatch = Array.from(new Set(signalsMatch.concat(failureSignals)));

  if (signalsMatch.length === 0) signalsMatch = ['error', 'constraint_violation'];

  var reasonSample = (group.failure_reasons || []).slice(0, 2).join('; ').slice(0, 200);
  var violationSample = (topPattern.top_violations || []).slice(0, 3).join(', ');

  var summary = 'Prevents repeated failure: ' + topPattern.reason_class;
  if (violationSample) summary += ' (guards against: ' + violationSample + ')';
  summary = summary.slice(0, 200);

  var strategy = [
    'GUARD: Check preconditions before making changes -- verify blast radius estimate is within limits.',
    'GUARD: Validate that target files are not in forbidden_paths before editing.',
    'APPLY: Make the smallest possible change to address the signal, favoring single-file patches.',
    'VERIFY: Run validation commands immediately after the change.',
    'ROLLBACK: If validation fails, revert all changes before proceeding.',
  ];

  if (violationSample) {
    strategy.splice(2, 0, 'GUARD: Previous failures involved "' + violationSample + '" -- add explicit checks to prevent recurrence.');
  }

  var idSeed = {
    type: 'Gene',
    signals_match: signalsMatch,
    summary: summary,
    strategy: strategy,
  };

  var gene = {
    type: 'Gene',
    id: REPAIR_DISTILLED_ID_PREFIX + deriveDescriptiveId(idSeed).replace(DISTILLED_ID_PREFIX, ''),
    summary: summary,
    category: 'repair',
    signals_match: signalsMatch,
    preconditions: ['Repeated failure pattern detected in recent capsules (' + topPattern.count + ' occurrences)'],
    strategy: strategy,
    constraints: {
      max_files: Math.min(DISTILLED_MAX_FILES, 8),
      forbidden_paths: ['.git', 'node_modules'],
    },
    validation: ['node --test'],
    schema_version: '1.6.0',
  };

  return gene;
}

function shouldDistillFromFailures() {
  if (String(process.env.SKILL_DISTILLER || 'true').toLowerCase() === 'false') return false;
  if (String(process.env.FAILURE_DISTILLER || 'true').toLowerCase() === 'false') return false;

  var state = readDistillerState();
  if (state.last_failure_distillation_at) {
    var elapsed = Date.now() - new Date(state.last_failure_distillation_at).getTime();
    if (elapsed < FAILURE_DISTILLER_INTERVAL_HOURS * 3600000) return false;
  }

  var assetsDir = paths.getGepAssetsDir();
  var failedPath = path.join(assetsDir, 'failed_capsules.json');
  var failedData = readJsonIfExists(failedPath, { failed_capsules: [] });
  var failedCapsules = Array.isArray(failedData.failed_capsules) ? failedData.failed_capsules : [];

  return failedCapsules.length >= FAILURE_DISTILLER_MIN_CAPSULES;
}

function autoDistillFromFailures() {
  var data = collectFailureDistillationData();
  if (data.failedCapsules.length < FAILURE_DISTILLER_MIN_CAPSULES) {
    return { ok: false, reason: 'insufficient_failures' };
  }

  var state = readDistillerState();
  if (state.last_failure_data_hash === data.dataHash) {
    return { ok: false, reason: 'idempotent_skip' };
  }

  var analysis = analyzeFailurePatterns(data);
  if (analysis.high_frequency_failures.length === 0) {
    return { ok: false, reason: 'no_recurring_pattern' };
  }

  var assetsDir = paths.getGepAssetsDir();
  var existingGenesJson = readJsonIfExists(path.join(assetsDir, 'genes.json'), { genes: [] });
  var existingGenes = existingGenesJson.genes || [];

  var rawGene = synthesizeRepairGeneFromFailures(data, analysis, existingGenes);
  if (!rawGene) return { ok: false, reason: 'no_candidate_gene' };

  var validation = validateSynthesizedGene(rawGene, existingGenes);
  if (!validation.valid) {
    appendJsonl(distillerLogPath(), {
      timestamp: new Date().toISOString(),
      data_hash: data.dataHash,
      status: 'failure_auto_validation_failed',
      synthesized_gene_id: validation.gene ? validation.gene.id : null,
      validation_errors: validation.errors,
      source: 'failure_distillation',
    });
    return { ok: false, reason: 'validation_failed', errors: validation.errors };
  }

  var gene = validation.gene;
  gene._distilled_meta = {
    distilled_at: new Date().toISOString(),
    source_failure_count: data.failedCapsules.length,
    data_hash: data.dataHash,
    auto_distilled: true,
    source: 'failure_distillation',
  };

  var assetStore = require('./assetStore');
  assetStore.upsertGene(gene);

  state.last_failure_distillation_at = new Date().toISOString();
  state.last_failure_data_hash = data.dataHash;
  state.last_failure_gene_id = gene.id;
  state.failure_distillation_count = (state.failure_distillation_count || 0) + 1;
  writeDistillerState(state);

  appendJsonl(distillerLogPath(), {
    timestamp: new Date().toISOString(),
    data_hash: data.dataHash,
    status: 'failure_auto_success',
    synthesized_gene_id: gene.id,
    source_failure_count: data.failedCapsules.length,
    analysis_summary: {
      high_frequency_count: analysis.high_frequency_failures.length,
      recurring_violations_count: analysis.recurring_violations.length,
    },
    source: 'failure_distillation',
    gene: gene,
  });

  console.log('[Distiller] Repair gene distilled from ' + data.failedCapsules.length + ' failures: ' + gene.id);
  return { ok: true, gene: gene, auto: true, source: 'failure_distillation' };
}

module.exports = {
  collectDistillationData: collectDistillationData,
  analyzePatterns: analyzePatterns,
  synthesizeGeneFromPatterns: synthesizeGeneFromPatterns,
  prepareDistillation: prepareDistillation,
  completeDistillation: completeDistillation,
  autoDistill: autoDistill,
  validateSynthesizedGene: validateSynthesizedGene,
  sanitizeSignalsMatch: sanitizeSignalsMatch,
  shouldDistill: shouldDistill,
  buildDistillationPrompt: buildDistillationPrompt,
  extractJsonFromLlmResponse: extractJsonFromLlmResponse,
  computeDataHash: computeDataHash,
  distillerLogPath: distillerLogPath,
  distillerStatePath: distillerStatePath,
  distillRequestPath: distillRequestPath,
  readDistillerState: readDistillerState,
  writeDistillerState: writeDistillerState,
  DISTILLED_ID_PREFIX: DISTILLED_ID_PREFIX,
  DISTILLED_MAX_FILES: DISTILLED_MAX_FILES,
  collectFailureDistillationData: collectFailureDistillationData,
  analyzeFailurePatterns: analyzeFailurePatterns,
  buildFailureDistillationPrompt: buildFailureDistillationPrompt,
  synthesizeRepairGeneFromFailures: synthesizeRepairGeneFromFailures,
  shouldDistillFromFailures: shouldDistillFromFailures,
  autoDistillFromFailures: autoDistillFromFailures,
  REPAIR_DISTILLED_ID_PREFIX: REPAIR_DISTILLED_ID_PREFIX,
  FAILURE_DISTILLER_MIN_CAPSULES: FAILURE_DISTILLER_MIN_CAPSULES,
};

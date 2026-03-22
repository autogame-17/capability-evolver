const { scoreTagOverlap } = require('./learningSignals');
const { captureEnvFingerprint } = require('./envFingerprint');

// ---------------------------------------------------------------------------
// Lightweight semantic similarity (bag-of-words cosine) for Gene selection.
// Acts as a complement to exact signals_match pattern matching.
// When EMBEDDING_PROVIDER is configured, can be replaced with real embeddings.
// ---------------------------------------------------------------------------
const SEMANTIC_WEIGHT = parseFloat(process.env.SEMANTIC_MATCH_WEIGHT || '0.4') || 0.4;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when',
  'are', 'was', 'has', 'had', 'not', 'but', 'its', 'can', 'will', 'all',
  'any', 'use', 'may', 'also', 'should', 'would', 'could',
]);

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length >= 2 && !STOP_WORDS.has(w); });
}

function buildTermFrequency(tokens) {
  var tf = {};
  for (var i = 0; i < tokens.length; i++) {
    tf[tokens[i]] = (tf[tokens[i]] || 0) + 1;
  }
  return tf;
}

function cosineSimilarity(tfA, tfB) {
  var keys = new Set(Object.keys(tfA).concat(Object.keys(tfB)));
  var dotProduct = 0;
  var normA = 0;
  var normB = 0;
  keys.forEach(function (k) {
    var a = tfA[k] || 0;
    var b = tfB[k] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  });
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scoreGeneSemantic(gene, signals) {
  if (!gene || !signals || signals.length === 0) return 0;

  var signalTokens = [];
  signals.forEach(function (s) {
    signalTokens = signalTokens.concat(tokenize(s));
  });
  if (signalTokens.length === 0) return 0;

  var geneTokens = [];
  if (Array.isArray(gene.signals_match)) {
    gene.signals_match.forEach(function (s) {
      geneTokens = geneTokens.concat(tokenize(s));
    });
  }
  if (gene.summary) geneTokens = geneTokens.concat(tokenize(gene.summary));
  if (gene.id) geneTokens = geneTokens.concat(tokenize(gene.id));
  if (geneTokens.length === 0) return 0;

  var tfSignals = buildTermFrequency(signalTokens);
  var tfGene = buildTermFrequency(geneTokens);
  return cosineSimilarity(tfSignals, tfGene);
}

function matchPatternToSignals(pattern, signals) {
  if (!pattern || !signals || signals.length === 0) return false;
  const p = String(pattern);
  const sig = signals.map(s => String(s));

  // Regex pattern: /body/flags
  const regexLike = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  if (regexLike) {
    const lastSlash = p.lastIndexOf('/');
    const body = p.slice(1, lastSlash);
    const flags = p.slice(lastSlash + 1);
    try {
      const re = new RegExp(body, flags || 'i');
      return sig.some(s => re.test(s));
    } catch (e) {
      // fallback to substring
    }
  }

  // Multi-language alias: "en_term|zh_term|ja_term" -- any branch matching = hit
  if (p.includes('|') && !p.startsWith('/')) {
    const branches = p.split('|').map(b => b.trim().toLowerCase()).filter(Boolean);
    return branches.some(needle => sig.some(s => s.toLowerCase().includes(needle)));
  }

  const needle = p.toLowerCase();
  return sig.some(s => s.toLowerCase().includes(needle));
}

function scoreGene(gene, signals) {
  if (!gene || gene.type !== 'Gene') return 0;
  const patterns = Array.isArray(gene.signals_match) ? gene.signals_match : [];
  const tagScore = scoreTagOverlap(gene, signals);
  if (patterns.length === 0) return tagScore > 0 ? tagScore * 0.6 : 0;
  let score = 0;
  for (const pat of patterns) {
    if (matchPatternToSignals(pat, signals)) score += 1;
  }
  const semanticScore = scoreGeneSemantic(gene, signals) * SEMANTIC_WEIGHT;
  return score + (tagScore * 0.6) + semanticScore;
}

function getEpigeneticBoostLocal(gene, envFingerprint) {
  if (!gene || !Array.isArray(gene.epigenetic_marks)) return 0;
  const platform = envFingerprint && envFingerprint.platform ? String(envFingerprint.platform) : '';
  const arch = envFingerprint && envFingerprint.arch ? String(envFingerprint.arch) : '';
  const nodeVersion = envFingerprint && envFingerprint.node_version ? String(envFingerprint.node_version) : '';
  const envContext = [platform, arch, nodeVersion].filter(Boolean).join('/') || 'unknown';
  const mark = gene.epigenetic_marks.find(function (m) { return m && m.context === envContext; });
  return mark ? Number(mark.boost) || 0 : 0;
}

function scoreGeneLearning(gene, signals, envFingerprint) {
  if (!gene || gene.type !== 'Gene') return 0;
  let boost = 0;

  const history = Array.isArray(gene.learning_history) ? gene.learning_history.slice(-8) : [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry) continue;
    if (entry.outcome === 'success') boost += 0.12;
    else if (entry.mode === 'hard') boost -= 0.22;
    else if (entry.mode === 'soft') boost -= 0.08;
  }

  boost += getEpigeneticBoostLocal(gene, envFingerprint);

  if (Array.isArray(gene.anti_patterns) && gene.anti_patterns.length > 0) {
    let overlapPenalty = 0;
    const signalTags = new Set(require('./learningSignals').expandSignals(signals, ''));
    const recentAntiPatterns = gene.anti_patterns.slice(-6);
    for (let j = 0; j < recentAntiPatterns.length; j++) {
      const anti = recentAntiPatterns[j];
      if (!anti || !Array.isArray(anti.learning_signals)) continue;
      const overlap = anti.learning_signals.some(function (tag) { return signalTags.has(String(tag)); });
      if (overlap) overlapPenalty += anti.mode === 'hard' ? 0.4 : 0.18;
    }
    boost -= overlapPenalty;
  }

  return Math.max(-1.5, Math.min(1.5, boost));
}

// Population-size-dependent drift intensity.
// In population genetics, genetic drift is stronger in small populations (Ne).
// driftIntensity: 0 = pure selection, 1 = pure drift (random).
// Formula: intensity = 1 / sqrt(Ne) where Ne = effective population size.
// This replaces the binary driftEnabled flag with a continuous spectrum.
function computeDriftIntensity(opts) {
  // If explicitly enabled/disabled, use that as the baseline
  const driftEnabled = !!(opts && opts.driftEnabled);

  // Effective population size: active gene count in the pool
  const effectivePopulationSize = opts && Number.isFinite(Number(opts.effectivePopulationSize))
    ? Number(opts.effectivePopulationSize)
    : null;

  // If no Ne provided, fall back to gene pool size
  const genePoolSize = opts && Number.isFinite(Number(opts.genePoolSize))
    ? Number(opts.genePoolSize)
    : null;

  const ne = effectivePopulationSize || genePoolSize || null;

  if (driftEnabled) {
    // Explicit drift: use moderate-to-high intensity
    return ne && ne > 1 ? Math.min(1, 1 / Math.sqrt(ne) + 0.3) : 0.7;
  }

  if (ne != null && ne > 0) {
    // Population-dependent drift: small population = more drift
    // Ne=1: intensity=1.0 (pure drift), Ne=25: intensity=0.2, Ne=100: intensity=0.1
    return Math.min(1, 1 / Math.sqrt(ne));
  }

  return 0; // No drift info available, pure selection
}

function selectGene(genes, signals, opts) {
  const genesList = Array.isArray(genes) ? genes : [];
  const bannedGeneIds = opts && opts.bannedGeneIds ? opts.bannedGeneIds : new Set();
  const driftEnabled = !!(opts && opts.driftEnabled);
  const preferredGeneId = opts && typeof opts.preferredGeneId === 'string' ? opts.preferredGeneId : null;

  // Diversity-directed drift: capability_gaps from Hub heartbeat
  const capabilityGaps = opts && Array.isArray(opts.capabilityGaps) ? opts.capabilityGaps : [];
  const noveltyScore = opts && Number.isFinite(Number(opts.noveltyScore)) ? Number(opts.noveltyScore) : null;

  // Compute continuous drift intensity based on effective population size
  const driftIntensity = computeDriftIntensity({
    driftEnabled: driftEnabled,
    effectivePopulationSize: opts && opts.effectivePopulationSize,
    genePoolSize: genesList.length,
  });
  const useDrift = driftEnabled || driftIntensity > 0.15;

  const DISTILLED_PREFIX = 'gene_distilled_';
  const DISTILLED_SCORE_FACTOR = 0.8;

  const envFingerprint = captureEnvFingerprint();
  const scored = genesList
    .map(g => {
      let s = scoreGene(g, signals);
      s += scoreGeneLearning(g, signals, envFingerprint);
      if (s > 0 && g.id && String(g.id).startsWith(DISTILLED_PREFIX)) s *= DISTILLED_SCORE_FACTOR;
      return { gene: g, score: s };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { selected: null, alternatives: [], driftIntensity: driftIntensity, driftMode: 'none' };

  // Memory graph preference: only override when the preferred gene is already a match candidate.
  if (preferredGeneId) {
    const preferred = scored.find(x => x.gene && x.gene.id === preferredGeneId);
    if (preferred && (useDrift || !bannedGeneIds.has(preferredGeneId))) {
      const rest = scored.filter(x => x.gene && x.gene.id !== preferredGeneId);
      const filteredRest = useDrift ? rest : rest.filter(x => x.gene && !bannedGeneIds.has(x.gene.id));
      return {
        selected: preferred.gene,
        alternatives: filteredRest.slice(0, 4).map(x => x.gene),
        driftIntensity: driftIntensity,
        driftMode: 'memory_preferred',
      };
    }
  }

  // Low-efficiency suppression: do not repeat low-confidence paths unless drift is active.
  const filtered = useDrift ? scored : scored.filter(x => x.gene && !bannedGeneIds.has(x.gene.id));
  if (filtered.length === 0) return { selected: null, alternatives: scored.slice(0, 4).map(x => x.gene), driftIntensity: driftIntensity, driftMode: 'none' };

  // Diversity-directed drift: when capability gaps are available, prefer genes that
  // cover gap areas instead of pure random selection. This replaces the blind
  // random drift with an informed exploration toward under-covered capabilities.
  let selectedIdx = 0;
  let driftMode = 'selection';
  if (driftIntensity > 0 && filtered.length > 1 && Math.random() < driftIntensity) {
    if (capabilityGaps.length > 0) {
      // Directed drift: score each candidate by how well its signals_match
      // covers the capability gap dimensions
      const gapScores = filtered.map(function(entry, idx) {
        const g = entry.gene;
        const patterns = Array.isArray(g.signals_match) ? g.signals_match : [];
        let gapHits = 0;
        for (let gi = 0; gi < capabilityGaps.length && gi < 5; gi++) {
          const gapSignal = capabilityGaps[gi];
          if (typeof gapSignal === 'string' && patterns.some(function(p) { return matchPatternToSignals(p, [gapSignal]); })) {
            gapHits++;
          }
        }
        return { idx: idx, gapHits: gapHits, baseScore: entry.score };
      });

      const hasGapHits = gapScores.some(function(gs) { return gs.gapHits > 0; });
      if (hasGapHits) {
        // Sort by gap coverage first, then by base score
        gapScores.sort(function(a, b) {
          return b.gapHits - a.gapHits || b.baseScore - a.baseScore;
        });
        selectedIdx = gapScores[0].idx;
        driftMode = 'diversity_directed';
      } else {
        // No gap match: fall back to novelty-weighted random selection
        let topN = Math.min(filtered.length, Math.max(2, Math.ceil(filtered.length * driftIntensity)));
        // If novelty score is low (agent is too similar to others), increase exploration range
        if (noveltyScore != null && noveltyScore < 0.3 && topN < filtered.length) {
          topN = Math.min(filtered.length, topN + 1);
        }
        selectedIdx = Math.floor(Math.random() * topN);
        driftMode = 'random_weighted';
      }
    } else {
      // No capability gap data: original random drift behavior
      const topN = Math.min(filtered.length, Math.max(2, Math.ceil(filtered.length * driftIntensity)));
      selectedIdx = Math.floor(Math.random() * topN);
      driftMode = 'random';
    }
  }

  return {
    selected: filtered[selectedIdx].gene,
    alternatives: filtered.filter(function(_, i) { return i !== selectedIdx; }).slice(0, 4).map(x => x.gene),
    driftIntensity: driftIntensity,
    driftMode: driftMode,
  };
}

function selectCapsule(capsules, signals) {
  const scored = (capsules || [])
    .map(c => {
      const triggers = Array.isArray(c.trigger) ? c.trigger : [];
      const score = triggers.reduce((acc, t) => (matchPatternToSignals(t, signals) ? acc + 1 : acc), 0);
      return { capsule: c, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].capsule : null;
}

function computeSignalOverlap(signalsA, signalsB) {
  if (!Array.isArray(signalsA) || !Array.isArray(signalsB)) return 0;
  if (signalsA.length === 0 || signalsB.length === 0) return 0;
  const setB = new Set(signalsB.map(function (s) { return String(s).toLowerCase(); }));
  let hits = 0;
  for (let i = 0; i < signalsA.length; i++) {
    if (setB.has(String(signalsA[i]).toLowerCase())) hits++;
  }
  return hits / Math.max(signalsA.length, 1);
}

const FAILED_CAPSULE_BAN_THRESHOLD = 2;
const FAILED_CAPSULE_OVERLAP_MIN = 0.6;

function banGenesFromFailedCapsules(failedCapsules, signals, existingBans) {
  const bans = existingBans instanceof Set ? new Set(existingBans) : new Set();
  if (!Array.isArray(failedCapsules) || failedCapsules.length === 0) return bans;
  const geneFailCounts = {};
  for (let i = 0; i < failedCapsules.length; i++) {
    const fc = failedCapsules[i];
    if (!fc || !fc.gene) continue;
    const overlap = computeSignalOverlap(signals, fc.trigger || []);
    if (overlap < FAILED_CAPSULE_OVERLAP_MIN) continue;
    const gid = String(fc.gene);
    geneFailCounts[gid] = (geneFailCounts[gid] || 0) + 1;
  }
  const keys = Object.keys(geneFailCounts);
  for (let j = 0; j < keys.length; j++) {
    if (geneFailCounts[keys[j]] >= FAILED_CAPSULE_BAN_THRESHOLD) {
      bans.add(keys[j]);
    }
  }
  return bans;
}

function selectGeneAndCapsule({ genes, capsules, signals, memoryAdvice, driftEnabled, failedCapsules, capabilityGaps, noveltyScore }) {
  const bannedGeneIds =
    memoryAdvice && memoryAdvice.bannedGeneIds instanceof Set ? memoryAdvice.bannedGeneIds : new Set();
  const preferredGeneId = memoryAdvice && memoryAdvice.preferredGeneId ? memoryAdvice.preferredGeneId : null;

  const effectiveBans = banGenesFromFailedCapsules(
    Array.isArray(failedCapsules) ? failedCapsules : [],
    signals,
    bannedGeneIds
  );

  const { selected, alternatives, driftIntensity } = selectGene(genes, signals, {
    bannedGeneIds: effectiveBans,
    preferredGeneId,
    driftEnabled: !!driftEnabled,
    capabilityGaps: Array.isArray(capabilityGaps) ? capabilityGaps : [],
    noveltyScore: Number.isFinite(Number(noveltyScore)) ? Number(noveltyScore) : null,
  });
  const capsule = selectCapsule(capsules, signals);
  const selector = buildSelectorDecision({
    gene: selected,
    capsule,
    signals,
    alternatives,
    memoryAdvice,
    driftEnabled,
    driftIntensity,
  });
  return {
    selectedGene: selected,
    capsuleCandidates: capsule ? [capsule] : [],
    selector,
    driftIntensity,
  };
}

function buildSelectorDecision({ gene, capsule, signals, alternatives, memoryAdvice, driftEnabled, driftIntensity }) {
  const reason = [];
  if (gene) reason.push('signals match gene.signals_match');
  if (capsule) reason.push('capsule trigger matches signals');
  if (!gene) reason.push('no matching gene found; new gene may be required');
  if (signals && signals.length) reason.push(`signals: ${signals.join(', ')}`);

  if (memoryAdvice && Array.isArray(memoryAdvice.explanation) && memoryAdvice.explanation.length) {
    reason.push(`memory_graph: ${memoryAdvice.explanation.join(' | ')}`);
  }
  if (driftEnabled) {
    reason.push('random_drift_override: true');
  }
  if (Number.isFinite(driftIntensity) && driftIntensity > 0) {
    reason.push(`drift_intensity: ${driftIntensity.toFixed(3)}`);
  }

  return {
    selected: gene ? gene.id : null,
    reason,
    alternatives: Array.isArray(alternatives) ? alternatives.map(g => g.id) : [],
  };
}

module.exports = {
  selectGeneAndCapsule,
  selectGene,
  selectCapsule,
  buildSelectorDecision,
  matchPatternToSignals,
  scoreGeneSemantic,
  cosineSimilarity,
  tokenize,
};


const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadGenes, upsertGene, appendEventJsonl, appendCapsule, upsertCapsule, getLastEventId, appendFailedCapsule } = require('./assetStore');
const { computeSignalKey, memoryGraphPath } = require('./memoryGraph');
const { computeCapsuleSuccessStreak, isBlastRadiusSafe } = require('./a2a');
const { getRepoRoot, getMemoryDir, getEvolutionDir, getWorkspaceRoot } = require('./paths');
const {
  runCmd, tryRunCmd, normalizeRelPath, countFileLines,
  gitListChangedFiles, gitListUntrackedFiles, captureDiffSnapshot, DIFF_SNAPSHOT_MAX_CHARS,
  isGitRepo, isCriticalProtectedPath, CRITICAL_PROTECTED_PREFIXES, CRITICAL_PROTECTED_FILES,
  rollbackTracked, rollbackNewUntrackedFiles,
} = require('./gitOps');
const {
  readOpenclawConstraintPolicy, isConstraintCountedPath, parseNumstatRows,
  computeBlastRadius, isForbiddenPath, checkConstraints,
  classifyBlastSeverity, analyzeBlastRadiusBreakdown, compareBlastEstimate,
  detectDestructiveChanges, isValidationCommandAllowed, runValidations, runCanaryCheck,
  buildFailureReason, buildSoftFailureLearningSignals, classifyFailureMode,
  BLAST_RADIUS_HARD_CAP_FILES, BLAST_RADIUS_HARD_CAP_LINES,
} = require('./policyCheck');
const { extractSignals } = require('./signals');
const { selectGene } = require('./selector');
const { isValidMutation, normalizeMutation, isHighRiskMutationAllowed, isHighRiskPersonality } = require('./mutation');
const {
  isValidPersonalityState,
  normalizePersonalityState,
  personalityKey,
  updatePersonalityStats,
} = require('./personality');
const { computeAssetId, SCHEMA_VERSION } = require('./contentHash');
const { captureEnvFingerprint } = require('./envFingerprint');
const { buildValidationReport } = require('./validationReport');
const { logAssetCall } = require('./assetCallLog');
const { recordNarrative } = require('./narrativeMemory');
const { isLlmReviewEnabled, runLlmReview } = require('./llmReview');
const { buildExecutionTrace } = require('./executionTrace');

function nowIso() {
  return new Date().toISOString();
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function stableHash(input) {
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// runCmd, tryRunCmd, gitListChangedFiles, countFileLines, normalizeRelPath
// moved to ./gitOps.js

// readOpenclawConstraintPolicy, matchAnyPrefix, matchAnyExact, matchAnyRegex,
// isConstraintCountedPath, parseNumstatRows moved to ./policyCheck.js

// computeBlastRadius, isForbiddenPath moved to ./policyCheck.js

// checkConstraints moved to ./policyCheck.js

function readStateForSolidify() {
  const memoryDir = getMemoryDir();
  const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
  return readJsonIfExists(statePath, { last_run: null });
}

function writeStateForSolidify(state) {
  const evolutionDir = getEvolutionDir();
  const statePath = path.join(evolutionDir, 'evolution_solidify_state.json');
  try {
    if (!fs.existsSync(evolutionDir)) fs.mkdirSync(evolutionDir, { recursive: true });
  } catch (e) {
    console.warn('[evolver] writeStateForSolidify mkdir failed:', evolutionDir, e && e.message || e);
  }
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

function buildEventId(tsIso) {
  const t = Date.parse(tsIso);
  return `evt_${Number.isFinite(t) ? t : Date.now()}`;
}

function buildCapsuleId(tsIso) {
  const t = Date.parse(tsIso);
  return `capsule_${Number.isFinite(t) ? t : Date.now()}`;
}

// BLAST_RADIUS_HARD_CAP_FILES, BLAST_RADIUS_HARD_CAP_LINES,
// classifyBlastSeverity, analyzeBlastRadiusBreakdown, compareBlastEstimate,
// detectDestructiveChanges, isValidationCommandAllowed, runValidations, runCanaryCheck,
// buildFailureReason, buildSoftFailureLearningSignals, classifyFailureMode
// moved to ./policyCheck.js

// BLAST_WARN_RATIO, BLAST_CRITICAL_RATIO defined in policyCheck.js

// classifyBlastSeverity through classifyFailureMode: all moved to ./policyCheck.js

function adaptGeneFromLearning(opts) {
  const gene = opts && opts.gene && opts.gene.type === 'Gene' ? opts.gene : null;
  if (!gene) return gene;

  const outcomeStatus = String(opts && opts.outcomeStatus || '').toLowerCase();
  const learningSignals = Array.isArray(opts && opts.learningSignals) ? opts.learningSignals : [];
  const failureMode = opts && opts.failureMode && typeof opts.failureMode === 'object'
    ? opts.failureMode
    : { mode: 'soft', reasonClass: 'unknown', retryable: true };

  if (!Array.isArray(gene.learning_history)) gene.learning_history = [];
  if (!Array.isArray(gene.signals_match)) gene.signals_match = [];

  const seenSignal = new Set(gene.signals_match.map(function (s) { return String(s); }));
  if (outcomeStatus === 'success') {
    for (let i = 0; i < learningSignals.length; i++) {
      const sig = String(learningSignals[i] || '');
      if (!sig || seenSignal.has(sig)) continue;
      if (sig.indexOf('problem:') === 0 || sig.indexOf('area:') === 0) {
        gene.signals_match.push(sig);
        seenSignal.add(sig);
      }
    }
  }

  gene.learning_history.push({
    at: nowIso(),
    outcome: outcomeStatus || 'unknown',
    mode: failureMode.mode || 'soft',
    reason_class: failureMode.reasonClass || 'unknown',
    retryable: !!failureMode.retryable,
    learning_signals: learningSignals.slice(0, 12),
  });
  if (gene.learning_history.length > 20) {
    gene.learning_history = gene.learning_history.slice(gene.learning_history.length - 20);
  }

  if (outcomeStatus === 'failed') {
    if (!Array.isArray(gene.anti_patterns)) gene.anti_patterns = [];
    const anti = {
      at: nowIso(),
      mode: failureMode.mode || 'soft',
      reason_class: failureMode.reasonClass || 'unknown',
      learning_signals: learningSignals.slice(0, 8),
    };
    gene.anti_patterns.push(anti);
    if (gene.anti_patterns.length > 12) {
      gene.anti_patterns = gene.anti_patterns.slice(gene.anti_patterns.length - 12);
    }
  }

  return gene;
}

// rollbackTracked, gitListUntrackedFiles moved to ./gitOps.js

// rollbackNewUntrackedFiles moved to ./gitOps.js

function inferCategoryFromSignals(signals) {
  const list = Array.isArray(signals) ? signals.map(String) : [];
  if (list.includes('log_error')) return 'repair';
  if (list.includes('protocol_drift')) return 'optimize';
  return 'optimize';
}

function buildSuccessReason({ gene, signals, blast, mutation, score }) {
  const parts = [];

  if (gene && gene.id) {
    const category = gene.category || 'unknown';
    parts.push(`Gene ${gene.id} (${category}) matched signals [${(signals || []).slice(0, 4).join(', ')}].`);
  }

  if (mutation && mutation.rationale) {
    parts.push(`Rationale: ${String(mutation.rationale).slice(0, 200)}.`);
  }

  if (blast) {
    parts.push(`Scope: ${blast.files} file(s), ${blast.lines} line(s) changed.`);
  }

  if (typeof score === 'number') {
    parts.push(`Outcome score: ${score.toFixed(2)}.`);
  }

  if (gene && Array.isArray(gene.strategy) && gene.strategy.length > 0) {
    parts.push(`Strategy applied: ${gene.strategy.slice(0, 3).join('; ').slice(0, 300)}.`);
  }

  return parts.join(' ').slice(0, 1000) || 'Evolution succeeded.';
}

const CAPSULE_CONTENT_MAX_CHARS = 8000;

function buildCapsuleContent({ intent, gene, signals, blast, mutation, score }) {
  const parts = [];

  if (intent) {
    parts.push('Intent: ' + String(intent).slice(0, 500));
  }

  if (gene && gene.id) {
    parts.push('Gene: ' + gene.id + ' (' + (gene.category || 'unknown') + ')');
  }

  if (signals && signals.length > 0) {
    parts.push('Signals: ' + signals.slice(0, 8).join(', '));
  }

  if (gene && Array.isArray(gene.strategy) && gene.strategy.length > 0) {
    parts.push('Strategy:\n' + gene.strategy.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n'));
  }

  if (blast) {
    const fileList = blast.changed_files || blast.all_changed_files || [];
    parts.push('Scope: ' + blast.files + ' file(s), ' + blast.lines + ' line(s)');
    if (fileList.length > 0) {
      parts.push('Changed files:\n' + fileList.slice(0, 20).join('\n'));
    }
  }

  if (mutation && mutation.rationale) {
    parts.push('Rationale: ' + String(mutation.rationale).slice(0, 500));
  }

  if (typeof score === 'number') {
    parts.push('Outcome score: ' + score.toFixed(2));
  }

  let result = parts.join('\n\n');
  if (result.length > CAPSULE_CONTENT_MAX_CHARS) {
    result = result.slice(0, CAPSULE_CONTENT_MAX_CHARS) + '\n... [TRUNCATED]';
  }
  return result || 'Evolution completed successfully.';
}

// ---------------------------------------------------------------------------
// Epigenetic Marks -- environmental imprints on Gene expression
// ---------------------------------------------------------------------------
// Epigenetic marks record environmental conditions under which a Gene performs
// well or poorly. Unlike mutations (which change the Gene itself), epigenetic
// marks modify expression strength without altering the underlying strategy.
// Marks propagate when Genes are reused (horizontal gene transfer) and decay
// over time (like biological DNA methylation patterns fading across generations).

function buildEpigeneticMark(context, boost, reason) {
  return {
    context: String(context || '').slice(0, 100),
    boost: Math.max(-0.5, Math.min(0.5, Number(boost) || 0)),
    reason: String(reason || '').slice(0, 200),
    created_at: new Date().toISOString(),
  };
}

function applyEpigeneticMarks(gene, envFingerprint, outcomeStatus) {
  if (!gene || gene.type !== 'Gene') return gene;

  // Initialize epigenetic_marks array if not present
  if (!Array.isArray(gene.epigenetic_marks)) {
    gene.epigenetic_marks = [];
  }

  const platform = envFingerprint && envFingerprint.platform ? String(envFingerprint.platform) : '';
  const arch = envFingerprint && envFingerprint.arch ? String(envFingerprint.arch) : '';
  const nodeVersion = envFingerprint && envFingerprint.node_version ? String(envFingerprint.node_version) : '';
  const envContext = [platform, arch, nodeVersion].filter(Boolean).join('/') || 'unknown';

  // Check if a mark for this context already exists
  const existingIdx = gene.epigenetic_marks.findIndex(
    (m) => m && m.context === envContext
  );

  if (outcomeStatus === 'success') {
    if (existingIdx >= 0) {
      // Reinforce: increase boost (max 0.5)
      const cur = gene.epigenetic_marks[existingIdx];
      cur.boost = Math.min(0.5, (Number(cur.boost) || 0) + 0.05);
      cur.reason = 'reinforced_by_success';
      cur.created_at = new Date().toISOString();
    } else {
      // New positive mark
      gene.epigenetic_marks.push(
        buildEpigeneticMark(envContext, 0.1, 'success_in_environment')
      );
    }
  } else if (outcomeStatus === 'failed') {
    if (existingIdx >= 0) {
      // Suppress: decrease boost
      const cur = gene.epigenetic_marks[existingIdx];
      cur.boost = Math.max(-0.5, (Number(cur.boost) || 0) - 0.1);
      cur.reason = 'suppressed_by_failure';
      cur.created_at = new Date().toISOString();
    } else {
      // New negative mark
      gene.epigenetic_marks.push(
        buildEpigeneticMark(envContext, -0.1, 'failure_in_environment')
      );
    }
  }

  // Decay old marks (keep max 10, remove marks older than 90 days)
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  gene.epigenetic_marks = gene.epigenetic_marks
    .filter((m) => m && new Date(m.created_at).getTime() > cutoff)
    .slice(-10);

  return gene;
}

function getEpigeneticBoost(gene, envFingerprint) {
  if (!gene || !Array.isArray(gene.epigenetic_marks)) return 0;
  const platform = envFingerprint && envFingerprint.platform ? String(envFingerprint.platform) : '';
  const arch = envFingerprint && envFingerprint.arch ? String(envFingerprint.arch) : '';
  const nodeVersion = envFingerprint && envFingerprint.node_version ? String(envFingerprint.node_version) : '';
  const envContext = [platform, arch, nodeVersion].filter(Boolean).join('/') || 'unknown';

  const mark = gene.epigenetic_marks.find((m) => m && m.context === envContext);
  return mark ? Number(mark.boost) || 0 : 0;
}

function buildAutoGene({ signals, intent }) {
  const sigs = Array.isArray(signals) ? Array.from(new Set(signals.map(String))).filter(Boolean) : [];
  const signalKey = computeSignalKey(sigs);
  const id = `gene_auto_${stableHash(signalKey)}`;
  const category = intent && ['repair', 'optimize', 'innovate'].includes(String(intent))
    ? String(intent)
    : inferCategoryFromSignals(sigs);
  const signalsMatch = sigs.length ? sigs.slice(0, 8) : ['(none)'];
  const gene = {
    type: 'Gene',
    schema_version: SCHEMA_VERSION,
    id,
    category,
    signals_match: signalsMatch,
    preconditions: [`signals_key == ${signalKey}`],
    strategy: [
      'Extract structured signals from logs and user instructions',
      'Select an existing Gene by signals match (no improvisation)',
      'Estimate blast radius (files, lines) before editing and record it',
      'Apply smallest reversible patch',
      'Validate using declared validation steps; rollback on failure',
      'Solidify knowledge: append EvolutionEvent, update Gene/Capsule store',
    ],
    constraints: {
      max_files: 12,
      forbidden_paths: [
        '.git', 'node_modules',
        'skills/feishu-evolver-wrapper', 'skills/feishu-common',
        'skills/feishu-post', 'skills/feishu-card', 'skills/feishu-doc',
        'skills/skill-tools', 'skills/clawhub', 'skills/clawhub-batch-undelete',
        'skills/git-sync',
      ],
    },
    validation: ['node scripts/validate-modules.js ./src/gep/solidify'],
    epigenetic_marks: [], // Epigenetic marks: environment-specific expression modifiers
  };
  gene.asset_id = computeAssetId(gene);
  return gene;
}

function ensureGene({ genes, selectedGene, signals, intent, dryRun }) {
  if (selectedGene && selectedGene.type === 'Gene') return { gene: selectedGene, created: false, reason: 'selected_gene_id_present' };
  const res = selectGene(Array.isArray(genes) ? genes : [], Array.isArray(signals) ? signals : [], {
    bannedGeneIds: new Set(), preferredGeneId: null, driftEnabled: false,
  });
  if (res && res.selected) return { gene: res.selected, created: false, reason: 'reselected_from_existing' };
  const auto = buildAutoGene({ signals, intent });
  if (!dryRun) upsertGene(auto);
  return { gene: auto, created: true, reason: 'no_match_create_new' };
}

function readRecentSessionInputs() {
  const repoRoot = getRepoRoot();
  const memoryDir = getMemoryDir();
  const rootMemory = path.join(repoRoot, 'MEMORY.md');
  const dirMemory = path.join(memoryDir, 'MEMORY.md');
  const memoryFile = fs.existsSync(rootMemory) ? rootMemory : dirMemory;
  const userFile = path.join(repoRoot, 'USER.md');
  const todayLog = path.join(memoryDir, new Date().toISOString().split('T')[0] + '.md');
  const todayLogContent = fs.existsSync(todayLog) ? fs.readFileSync(todayLog, 'utf8') : '';
  const memorySnippet = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8').slice(0, 50000) : '';
  const userSnippet = fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8') : '';
  const recentSessionTranscript = '';
  return { recentSessionTranscript, todayLog: todayLogContent, memorySnippet, userSnippet };
}

// isGitRepo moved to ./gitOps.js

function solidify({ intent, summary, dryRun = false, rollbackOnFailure = true } = {}) {
  const repoRoot = getRepoRoot();

  if (!isGitRepo(repoRoot)) {
    console.error('[Solidify] FATAL: Not a git repository (' + repoRoot + ').');
    console.error('[Solidify] Solidify requires git for rollback, diff capture, and blast radius.');
    console.error('[Solidify] Run "git init && git add -A && git commit -m init" first.');
    return {
      ok: false,
      status: 'failed',
      failure_reason: 'not_a_git_repository',
      event: null,
    };
  }
  const state = readStateForSolidify();
  const lastRun = state && state.last_run ? state.last_run : null;
  const genes = loadGenes();
  const geneId = lastRun && lastRun.selected_gene_id ? String(lastRun.selected_gene_id) : null;
  const selectedGene = geneId ? genes.find(g => g && g.type === 'Gene' && g.id === geneId) : null;
  const parentEventId =
    lastRun && typeof lastRun.parent_event_id === 'string' ? lastRun.parent_event_id : getLastEventId();
  const signals =
    lastRun && Array.isArray(lastRun.signals) && lastRun.signals.length
      ? Array.from(new Set(lastRun.signals.map(String)))
      : extractSignals(readRecentSessionInputs());
  const signalKey = computeSignalKey(signals);

  const mutationRaw = lastRun && lastRun.mutation && typeof lastRun.mutation === 'object' ? lastRun.mutation : null;
  const personalityRaw =
    lastRun && lastRun.personality_state && typeof lastRun.personality_state === 'object' ? lastRun.personality_state : null;
  const mutation = mutationRaw && isValidMutation(mutationRaw) ? normalizeMutation(mutationRaw) : null;
  const personalityState =
    personalityRaw && isValidPersonalityState(personalityRaw) ? normalizePersonalityState(personalityRaw) : null;
  const personalityKeyUsed = personalityState ? personalityKey(personalityState) : null;
  const protocolViolations = [];
  if (!mutation) protocolViolations.push('missing_or_invalid_mutation');
  if (!personalityState) protocolViolations.push('missing_or_invalid_personality_state');
  if (mutation && mutation.risk_level === 'high' && !isHighRiskMutationAllowed(personalityState || null)) {
    protocolViolations.push('high_risk_mutation_not_allowed_by_personality');
  }
  if (mutation && mutation.risk_level === 'high' && !(lastRun && lastRun.personality_known)) {
    protocolViolations.push('high_risk_mutation_forbidden_under_unknown_personality');
  }
  if (mutation && mutation.category === 'innovate' && personalityState && isHighRiskPersonality(personalityState)) {
    protocolViolations.push('forbidden_innovate_with_high_risk_personality');
  }

  const ensured = ensureGene({ genes, selectedGene, signals, intent, dryRun: !!dryRun });
  const geneUsed = ensured.gene;
  const blast = computeBlastRadius({
    repoRoot,
    baselineUntracked: lastRun && Array.isArray(lastRun.baseline_untracked) ? lastRun.baseline_untracked : [],
  });
  const blastRadiusEstimate = lastRun && lastRun.blast_radius_estimate ? lastRun.blast_radius_estimate : null;
  const constraintCheck = checkConstraints({ gene: geneUsed, blast, blastRadiusEstimate, repoRoot });

  // Log blast radius diagnostics when severity is elevated.
  if (constraintCheck.blastSeverity &&
      constraintCheck.blastSeverity.severity !== 'within_limit' &&
      constraintCheck.blastSeverity.severity !== 'approaching_limit') {
    const breakdown = analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || []);
    console.error(`[Solidify] Blast radius breakdown: ${JSON.stringify(breakdown)}`);
    const estComp = compareBlastEstimate(blastRadiusEstimate, blast);
    if (estComp) {
      console.error(`[Solidify] Estimate comparison: estimated ${estComp.estimateFiles} files, actual ${estComp.actualFiles} files (${estComp.ratio}x)`);
    }
  }

  // Log warnings even on success (approaching limit, estimate drift).
  if (constraintCheck.warnings && constraintCheck.warnings.length > 0) {
    for (const w of constraintCheck.warnings) {
      console.log(`[Solidify] WARNING: ${w}`);
    }
  }

  // Critical safety: detect destructive changes to core dependencies.
  const destructiveViolations = detectDestructiveChanges({
    repoRoot,
    changedFiles: blast.all_changed_files || blast.changed_files || [],
    baselineUntracked: lastRun && Array.isArray(lastRun.baseline_untracked) ? lastRun.baseline_untracked : [],
  });
  if (destructiveViolations.length > 0) {
    for (const v of destructiveViolations) {
      constraintCheck.violations.push(v);
    }
    constraintCheck.ok = false;
    console.error(`[Solidify] CRITICAL: Destructive changes detected: ${destructiveViolations.join('; ')}`);
  }

  // Capture environment fingerprint before validation.
  const envFp = captureEnvFingerprint();

  let validation = { ok: true, results: [], startedAt: null, finishedAt: null };
  if (geneUsed) {
    validation = runValidations(geneUsed, { repoRoot, timeoutMs: 180000 });
  }

  // Canary safety: verify index.js loads in an isolated child process.
  // This catches broken entry points that gene validations might miss.
  const canary = runCanaryCheck({ repoRoot, timeoutMs: 30000 });
  if (!canary.ok && !canary.skipped) {
    constraintCheck.violations.push(
      `canary_failed: index.js cannot load in child process: ${canary.err}`
    );
    constraintCheck.ok = false;
    console.error(`[Solidify] CANARY FAILED: ${canary.err}`);
  }

  // Optional LLM review: when EVOLVER_LLM_REVIEW=true, submit diff for review.
  let llmReviewResult = null;
  if (constraintCheck.ok && validation.ok && protocolViolations.length === 0 && isLlmReviewEnabled()) {
    try {
      const reviewDiff = captureDiffSnapshot(repoRoot);
      llmReviewResult = runLlmReview({
        diff: reviewDiff,
        gene: geneUsed,
        signals,
        mutation,
      });
      if (llmReviewResult && llmReviewResult.approved === false) {
        constraintCheck.violations.push('llm_review_rejected: ' + (llmReviewResult.summary || 'no reason'));
        constraintCheck.ok = false;
        console.log('[LLMReview] Change REJECTED: ' + (llmReviewResult.summary || ''));
      } else if (llmReviewResult) {
        console.log('[LLMReview] Change approved (confidence: ' + (llmReviewResult.confidence || '?') + ')');
      }
    } catch (e) {
      console.log('[LLMReview] Failed (non-fatal): ' + (e && e.message ? e.message : e));
    }
  }

  // Build standardized ValidationReport (machine-readable, interoperable).
  const validationReport = buildValidationReport({
    geneId: geneUsed && geneUsed.id ? geneUsed.id : null,
    commands: validation.results.map(function (r) { return r.cmd; }),
    results: validation.results,
    envFp: envFp,
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
  });

  const success = constraintCheck.ok && validation.ok && protocolViolations.length === 0;
  const ts = nowIso();
  const outcomeStatus = success ? 'success' : 'failed';
  const score = clamp01(success ? 0.85 : 0.2);
  const failureReason = !success ? buildFailureReason(constraintCheck, validation, protocolViolations, canary) : '';
  const failureMode = !success
    ? classifyFailureMode({
        constraintViolations: constraintCheck.violations,
        protocolViolations: protocolViolations,
        validation: validation,
        canary: canary,
      })
    : { mode: 'none', reasonClass: null, retryable: false };
  const softFailureLearningSignals = !success
    ? buildSoftFailureLearningSignals({
        signals,
        failureReason,
        violations: constraintCheck.violations,
        validationResults: validation.results,
      })
    : [];

  const selectedCapsuleId =
    lastRun && typeof lastRun.selected_capsule_id === 'string' && lastRun.selected_capsule_id.trim()
      ? String(lastRun.selected_capsule_id).trim() : null;
  const capsuleId = success ? selectedCapsuleId || buildCapsuleId(ts) : null;
  const derivedIntent = intent || (mutation && mutation.category) || (geneUsed && geneUsed.category) || 'repair';
  const intentMismatch =
    intent && mutation && typeof mutation.category === 'string' && String(intent) !== String(mutation.category);
  if (intentMismatch) protocolViolations.push(`intent_mismatch_with_mutation:${String(intent)}!=${String(mutation.category)}`);

  const sourceType = lastRun && lastRun.source_type ? String(lastRun.source_type) : 'generated';
  const reusedAssetId = lastRun && lastRun.reused_asset_id ? String(lastRun.reused_asset_id) : null;
  const reusedChainId = lastRun && lastRun.reused_chain_id ? String(lastRun.reused_chain_id) : null;

  // LessonL: carry applied lesson IDs for Hub effectiveness adjustment
  const appliedLessons = lastRun && Array.isArray(lastRun.applied_lessons) ? lastRun.applied_lessons : [];

  const event = {
    type: 'EvolutionEvent',
    schema_version: SCHEMA_VERSION,
    id: buildEventId(ts),
    parent: parentEventId || null,
    intent: derivedIntent,
    signals,
    genes_used: geneUsed && geneUsed.id ? [geneUsed.id] : [],
    mutation_id: mutation && mutation.id ? mutation.id : null,
    personality_state: personalityState || null,
    blast_radius: { files: blast.files, lines: blast.lines },
    outcome: { status: outcomeStatus, score },
    capsule_id: capsuleId,
    source_type: sourceType,
    reused_asset_id: reusedAssetId,
    ...(appliedLessons.length > 0 ? { applied_lessons: appliedLessons } : {}),
    env_fingerprint: envFp,
    validation_report_id: validationReport.id,
    meta: {
      at: ts,
      signal_key: signalKey,
      selector: lastRun && lastRun.selector ? lastRun.selector : null,
      blast_radius_estimate: lastRun && lastRun.blast_radius_estimate ? lastRun.blast_radius_estimate : null,
      mutation: mutation || null,
      personality: {
        key: personalityKeyUsed,
        known: !!(lastRun && lastRun.personality_known),
        mutations: lastRun && Array.isArray(lastRun.personality_mutations) ? lastRun.personality_mutations : [],
      },
      gene: {
        id: geneUsed && geneUsed.id ? geneUsed.id : null,
        created: !!ensured.created,
        reason: ensured.reason,
      },
      constraints_ok: constraintCheck.ok,
      constraint_violations: constraintCheck.violations,
      constraint_warnings: constraintCheck.warnings || [],
      blast_severity: constraintCheck.blastSeverity ? constraintCheck.blastSeverity.severity : null,
      blast_breakdown: (!constraintCheck.ok && blast)
        ? analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || [])
        : null,
      blast_estimate_comparison: compareBlastEstimate(blastRadiusEstimate, blast),
      validation_ok: validation.ok,
      validation: validation.results.map(r => ({ cmd: r.cmd, ok: r.ok })),
      validation_report: validationReport,
      canary_ok: canary.ok,
      canary_skipped: !!canary.skipped,
      protocol_ok: protocolViolations.length === 0,
      protocol_violations: protocolViolations,
      memory_graph: memoryGraphPath(),
      soft_failure: success ? null : {
        learning_signals: softFailureLearningSignals,
        retryable: !!failureMode.retryable,
        class: failureMode.reasonClass,
        mode: failureMode.mode,
      },
    },
  };
  // Build desensitized execution trace for cross-agent experience sharing
  const executionTrace = buildExecutionTrace({
    gene: geneUsed,
    mutation,
    signals,
    blast,
    constraintCheck,
    validation,
    canary,
    outcomeStatus,
    startedAt: validation.startedAt,
  });
  if (executionTrace) {
    event.execution_trace = executionTrace;
  }

  event.asset_id = computeAssetId(event);

  let capsule = null;
  if (success) {
    const s = String(summary || '').trim();
    const autoSummary = geneUsed
      ? `固化：${geneUsed.id} 命中信号 ${signals.join(', ') || '(none)'}，变更 ${blast.files} 文件 / ${blast.lines} 行。`
      : `固化：命中信号 ${signals.join(', ') || '(none)'}，变更 ${blast.files} 文件 / ${blast.lines} 行。`;
    let prevCapsule = null;
    try {
      if (selectedCapsuleId) {
        const list = require('./assetStore').loadCapsules();
        prevCapsule = Array.isArray(list) ? list.find(c => c && c.type === 'Capsule' && String(c.id) === selectedCapsuleId) : null;
      }
    } catch (e) {
      console.warn('[evolver] solidify loadCapsules failed:', e && e.message || e);
    }
    const successReason = buildSuccessReason({ gene: geneUsed, signals, blast, mutation, score });
    const capsuleDiff = captureDiffSnapshot(repoRoot);
    const capsuleContent = buildCapsuleContent({ intent, gene: geneUsed, signals, blast, mutation, score });
    const capsuleStrategy = geneUsed && Array.isArray(geneUsed.strategy) && geneUsed.strategy.length > 0
      ? geneUsed.strategy : undefined;
    capsule = {
      type: 'Capsule',
      schema_version: SCHEMA_VERSION,
      id: capsuleId,
      trigger: prevCapsule && Array.isArray(prevCapsule.trigger) && prevCapsule.trigger.length ? prevCapsule.trigger : signals,
      gene: geneUsed && geneUsed.id ? geneUsed.id : prevCapsule && prevCapsule.gene ? prevCapsule.gene : null,
      summary: s || (prevCapsule && prevCapsule.summary ? String(prevCapsule.summary) : autoSummary),
      confidence: clamp01(score),
      blast_radius: { files: blast.files, lines: blast.lines },
      outcome: { status: 'success', score },
      success_streak: 1,
      success_reason: successReason,
      env_fingerprint: envFp,
      source_type: sourceType,
      reused_asset_id: reusedAssetId,
      a2a: { eligible_to_broadcast: false },
      content: capsuleContent,
      diff: capsuleDiff || undefined,
      strategy: capsuleStrategy,
    };
    capsule.asset_id = computeAssetId(capsule);
  }

  // Capture failed mutation as a FailedCapsule before rollback destroys the diff.
  if (!dryRun && !success) {
    try {
      const diffSnapshot = captureDiffSnapshot(repoRoot);
      if (diffSnapshot) {
        const failedCapsule = {
          type: 'Capsule',
          schema_version: SCHEMA_VERSION,
          id: 'failed_' + buildCapsuleId(ts),
          outcome: { status: 'failed', score: score },
          gene: geneUsed && geneUsed.id ? geneUsed.id : null,
          trigger: Array.isArray(signals) ? signals.slice(0, 8) : [],
          summary: geneUsed
            ? 'Failed: ' + geneUsed.id + ' on signals [' + (signals.slice(0, 3).join(', ') || 'none') + ']'
            : 'Failed evolution on signals [' + (signals.slice(0, 3).join(', ') || 'none') + ']',
          diff_snapshot: diffSnapshot,
          failure_reason: failureReason,
          learning_signals: softFailureLearningSignals,
          constraint_violations: constraintCheck.violations || [],
          env_fingerprint: envFp,
          blast_radius: { files: blast.files, lines: blast.lines },
          created_at: ts,
        };
        failedCapsule.asset_id = computeAssetId(failedCapsule);
        appendFailedCapsule(failedCapsule);
        console.log('[Solidify] Preserved failed mutation as FailedCapsule: ' + failedCapsule.id);
      }
    } catch (e) {
      console.log('[Solidify] FailedCapsule capture error (non-fatal): ' + (e && e.message ? e.message : e));
    }
  }

  if (!dryRun && !success && rollbackOnFailure) {
    rollbackTracked(repoRoot);
    // Only clean up new untracked files when a valid baseline exists.
    // Without a baseline, we cannot distinguish pre-existing untracked files
    // from AI-generated ones, so deleting would be destructive.
    if (lastRun && Array.isArray(lastRun.baseline_untracked)) {
      rollbackNewUntrackedFiles({ repoRoot, baselineUntracked: lastRun.baseline_untracked });
    }
  }

  // Apply epigenetic marks to the gene based on outcome and environment
  if (!dryRun && geneUsed && geneUsed.type === 'Gene') {
    try {
      adaptGeneFromLearning({
        gene: geneUsed,
        outcomeStatus: outcomeStatus,
        learningSignals: success ? signals : softFailureLearningSignals,
        failureMode: failureMode,
      });
      applyEpigeneticMarks(geneUsed, envFp, outcomeStatus);
      upsertGene(geneUsed);
    } catch (e) {
      console.warn('[evolver] applyEpigeneticMarks failed (non-blocking):', e && e.message || e);
    }
  }

  if (!dryRun) {
    appendEventJsonl(validationReport);
    if (capsule) upsertCapsule(capsule);
    appendEventJsonl(event);
    if (capsule) {
      const streak = computeCapsuleSuccessStreak({ capsuleId: capsule.id });
      capsule.success_streak = streak || 1;
      capsule.a2a = {
        eligible_to_broadcast:
          isBlastRadiusSafe(capsule.blast_radius) &&
          (capsule.outcome.score || 0) >= 0.7 &&
          (capsule.success_streak || 0) >= 2,
      };
      capsule.asset_id = computeAssetId(capsule);
      upsertCapsule(capsule);
    }
    try {
      if (personalityState) {
        updatePersonalityStats({ personalityState, outcome: outcomeStatus, score, notes: `event:${event.id}` });
      }
    } catch (e) {
      console.warn('[evolver] updatePersonalityStats failed:', e && e.message || e);
    }
  }

  const runId = lastRun && lastRun.run_id ? String(lastRun.run_id) : stableHash(`${parentEventId || 'root'}|${geneId || 'none'}|${signalKey}`);
  state.last_solidify = {
    run_id: runId, at: ts, event_id: event.id, capsule_id: capsuleId, outcome: event.outcome,
  };
  if (!dryRun) {
    state.solidify_count = (state.solidify_count || 0) + 1;
    writeStateForSolidify(state);
  }

  if (!dryRun) {
    try {
      recordNarrative({
        gene: geneUsed,
        signals,
        mutation,
        outcome: event.outcome,
        blast,
        capsule,
      });
    } catch (e) {
      console.log('[Narrative] Record failed (non-fatal): ' + (e && e.message ? e.message : e));
    }
  }

  // Search-First Evolution: auto-publish eligible capsules to the Hub (as Gene+Capsule bundle).
  let publishResult = null;
  if (!dryRun && capsule && capsule.a2a && capsule.a2a.eligible_to_broadcast) {
    const autoPublish = String(process.env.EVOLVER_AUTO_PUBLISH || 'true').toLowerCase() !== 'false';
    const visibility = String(process.env.EVOLVER_DEFAULT_VISIBILITY || 'public').toLowerCase();
    const minPublishScore = Number(process.env.EVOLVER_MIN_PUBLISH_SCORE) || 0.78;

    // Skip publishing if: disabled, private, direct-reused asset, or below minimum score.
    // 'reference' mode produces a new capsule inspired by hub -- eligible for publish.
    if (autoPublish && visibility === 'public' && sourceType !== 'reused' && (capsule.outcome.score || 0) >= minPublishScore) {
      try {
        const { buildPublishBundle, httpTransportSend } = require('./a2aProtocol');
        const { sanitizePayload } = require('./sanitize');
        const hubUrl = (process.env.A2A_HUB_URL || '').replace(/\/+$/, '');

        if (hubUrl) {
          // Hub requires bundle format: Gene + Capsule published together.
          // Build a Gene object from geneUsed if available; otherwise synthesize a minimal Gene.
          const publishGene = null;
          if (geneUsed && geneUsed.type === 'Gene' && geneUsed.id) {
            publishGene = sanitizePayload(geneUsed);
          } else {
            publishGene = {
              type: 'Gene',
              id: capsule.gene || ('gene_auto_' + (capsule.id || Date.now())),
              category: event && event.intent ? event.intent : 'repair',
              signals_match: Array.isArray(capsule.trigger) ? capsule.trigger : [],
              summary: capsule.summary || '',
            };
          }
          const parentRef = reusedAssetId && sourceType === 'reference' && String(reusedAssetId).startsWith('sha256:')
            ? reusedAssetId : null;
          if (parentRef) {
            publishGene.parent = parentRef;
          }
          publishGene.asset_id = computeAssetId(publishGene);

          const sanitizedCapsule = sanitizePayload(capsule);
          if (parentRef) {
            sanitizedCapsule.parent = parentRef;
          }
          sanitizedCapsule.asset_id = computeAssetId(sanitizedCapsule);

          const sanitizedEvent = (event && event.type === 'EvolutionEvent') ? sanitizePayload(event) : null;
          if (sanitizedEvent) sanitizedEvent.asset_id = computeAssetId(sanitizedEvent);

          const publishChainId = reusedChainId || null;

          const evolverModelName = (process.env.EVOLVER_MODEL_NAME || '').trim().slice(0, 100);

          const msg = buildPublishBundle({
            gene: publishGene,
            capsule: sanitizedCapsule,
            event: sanitizedEvent,
            chainId: publishChainId,
            modelName: evolverModelName || undefined,
          });
          const result = httpTransportSend(msg, { hubUrl });
          // httpTransportSend returns a Promise
          if (result && typeof result.then === 'function') {
            result
              .then(function (res) {
                if (res && res.ok) {
                  console.log('[AutoPublish] Published bundle (Gene+Capsule) ' + (capsule.asset_id || capsule.id) + ' to Hub.');
                } else {
                  console.log('[AutoPublish] Hub rejected: ' + JSON.stringify(res));
                }
              })
              .catch(function (err) {
                console.log('[AutoPublish] Failed (non-fatal): ' + err.message);
              });
          }
          publishResult = { attempted: true, asset_id: capsule.asset_id || capsule.id, bundle: true };
          logAssetCall({
            run_id: lastRun && lastRun.run_id ? lastRun.run_id : null,
            action: 'asset_publish',
            asset_id: capsule.asset_id || capsule.id,
            asset_type: 'Capsule',
            source_node_id: null,
            chain_id: publishChainId || null,
            signals: Array.isArray(capsule.trigger) ? capsule.trigger : [],
            extra: {
              source_type: sourceType,
              reused_asset_id: reusedAssetId,
              gene_id: publishGene && publishGene.id ? publishGene.id : null,
              parent: parentRef || null,
            },
          });
        } else {
          publishResult = { attempted: false, reason: 'no_hub_url' };
        }
      } catch (e) {
        console.log('[AutoPublish] Error (non-fatal): ' + e.message);
        publishResult = { attempted: false, reason: e.message };
      }
    } else {
      const reason = !autoPublish ? 'auto_publish_disabled'
        : visibility !== 'public' ? 'visibility_private'
        : sourceType === 'reused' ? 'skip_direct_reused_asset'
        : 'below_min_score';
      publishResult = { attempted: false, reason };
      logAssetCall({
        run_id: lastRun && lastRun.run_id ? lastRun.run_id : null,
        action: 'asset_publish_skip',
        asset_id: capsule.asset_id || capsule.id,
        asset_type: 'Capsule',
        reason,
        signals: Array.isArray(capsule.trigger) ? capsule.trigger : [],
      });
    }
  }

  // --- Anti-pattern auto-publish ---
  // Publish high-information-value failures to the Hub as anti-pattern assets.
  // Only enabled via EVOLVER_PUBLISH_ANTI_PATTERNS=true (opt-in).
  // Only constraint violations or canary failures qualify (not routine validation failures).
  let antiPatternPublishResult = null;
  if (!dryRun && !success) {
    const publishAntiPatterns = String(process.env.EVOLVER_PUBLISH_ANTI_PATTERNS || '').toLowerCase() === 'true';
    const hubUrl = (process.env.A2A_HUB_URL || '').replace(/\/+$/, '');
    const hasHighInfoFailure = (constraintCheck.violations && constraintCheck.violations.length > 0)
      || (canary && !canary.ok && !canary.skipped);
    if (publishAntiPatterns && hubUrl && hasHighInfoFailure) {
      try {
        const { buildPublishBundle: buildApBundle, httpTransportSend: httpApSend } = require('./a2aProtocol');
        const { sanitizePayload: sanitizeAp } = require('./sanitize');
        const apGene = geneUsed && geneUsed.type === 'Gene' && geneUsed.id
          ? sanitizeAp(geneUsed)
          : { type: 'Gene', id: 'gene_unknown_' + Date.now(), category: derivedIntent, signals_match: signals.slice(0, 8), summary: 'Failed evolution gene' };
        apGene.anti_pattern = true;
        apGene.failure_reason = buildFailureReason(constraintCheck, validation, protocolViolations, canary);
        apGene.asset_id = computeAssetId(apGene);
        const apCapsule = {
          type: 'Capsule',
          schema_version: SCHEMA_VERSION,
          id: 'failed_' + buildCapsuleId(ts),
          trigger: signals.slice(0, 8),
          gene: apGene.id,
          summary: 'Anti-pattern: ' + String(apGene.failure_reason).slice(0, 200),
          confidence: 0,
          blast_radius: { files: blast.files, lines: blast.lines },
          outcome: { status: 'failed', score: score },
          failure_reason: apGene.failure_reason,
          a2a: { eligible_to_broadcast: false },
        };
        apCapsule.asset_id = computeAssetId(apCapsule);
        const apModelName = (process.env.EVOLVER_MODEL_NAME || '').trim().slice(0, 100);
        const apMsg = buildApBundle({ gene: apGene, capsule: sanitizeAp(apCapsule), event: null, modelName: apModelName || undefined });
        const apResult = httpApSend(apMsg, { hubUrl });
        if (apResult && typeof apResult.then === 'function') {
          apResult
            .then(function (res) {
              if (res && res.ok) console.log('[AntiPatternPublish] Published failed bundle to Hub: ' + apCapsule.id);
              else console.log('[AntiPatternPublish] Hub rejected: ' + JSON.stringify(res));
            })
            .catch(function (err) {
              console.log('[AntiPatternPublish] Failed (non-fatal): ' + err.message);
            });
        }
        antiPatternPublishResult = { attempted: true, asset_id: apCapsule.asset_id };
      } catch (e) {
        console.log('[AntiPatternPublish] Error (non-fatal): ' + e.message);
        antiPatternPublishResult = { attempted: false, reason: e.message };
      }
    }
  }

  // --- LessonL: Auto-publish negative lesson to Hub (always-on, lightweight) ---
  // Unlike anti-pattern publishing (opt-in, full capsule bundle), this publishes
  // just the failure reason as a structured lesson via the EvolutionEvent.
  // The Hub's solicitLesson() hook on handlePublish will extract the lesson.
  // This is achieved by ensuring failure_reason is included in the event metadata,
  // which we already do above. The Hub-side solicitLesson() handles the rest.
  // For failures without a published event (no auto-publish), we still log locally.
  if (!dryRun && !success && event && event.outcome) {
    const failureContent = failureReason;
    event.failure_reason = failureContent;
    event.summary = geneUsed
      ? 'Failed: ' + geneUsed.id + ' on signals [' + (signals.slice(0, 3).join(', ') || 'none') + '] - ' + failureContent.slice(0, 200)
      : 'Failed evolution on signals [' + (signals.slice(0, 3).join(', ') || 'none') + '] - ' + failureContent.slice(0, 200);
  }

  // --- Auto-complete Hub task ---
  // If this evolution cycle was driven by a Hub task, mark it as completed
  // with the produced capsule's asset_id. Runs after publish so the Hub
  // can link the task result to the published asset.
  let taskCompleteResult = null;
  if (!dryRun && success && lastRun && lastRun.active_task_id) {
    const resultAssetId = capsule && capsule.asset_id ? capsule.asset_id : (capsule && capsule.id ? capsule.id : null);
    if (resultAssetId) {
      const workerAssignmentId = lastRun.worker_assignment_id || null;
      const workerPending = lastRun.worker_pending || false;
      if (workerPending && !workerAssignmentId) {
        // Deferred claim mode: claim + complete atomically now that we have a result
        try {
          const { claimAndCompleteWorkerTask } = require('./taskReceiver');
          const taskId = String(lastRun.active_task_id);
          console.log(`[WorkerPool] Atomic claim+complete for task "${lastRun.active_task_title || taskId}" with asset ${resultAssetId}`);
          const result = claimAndCompleteWorkerTask(taskId, resultAssetId);
          if (result && typeof result.then === 'function') {
            result
              .then(function (r) {
                if (r.ok) {
                  console.log('[WorkerPool] Claim+complete succeeded, assignment=' + r.assignment_id);
                } else {
                  console.log('[WorkerPool] Claim+complete failed: ' + (r.error || 'unknown') + (r.assignment_id ? ' assignment=' + r.assignment_id : ''));
                }
              })
              .catch(function (err) {
                console.log('[WorkerPool] Claim+complete error (non-fatal): ' + (err && err.message ? err.message : err));
              });
          }
          taskCompleteResult = { attempted: true, task_id: lastRun.active_task_id, asset_id: resultAssetId, worker: true, deferred: true };
        } catch (e) {
          console.log('[WorkerPool] Atomic claim+complete error (non-fatal): ' + e.message);
          taskCompleteResult = { attempted: false, reason: e.message, worker: true, deferred: true };
        }
      } else if (workerAssignmentId) {
        // Legacy path: already-claimed assignment, just complete it
        try {
          const { completeWorkerTask } = require('./taskReceiver');
          console.log(`[WorkerComplete] Completing worker assignment "${workerAssignmentId}" with asset ${resultAssetId}`);
          const completed = completeWorkerTask(workerAssignmentId, resultAssetId);
          if (completed && typeof completed.then === 'function') {
            completed
              .then(function (ok) {
                if (ok) {
                  console.log('[WorkerComplete] Worker task completed successfully on Hub.');
                } else {
                  console.log('[WorkerComplete] Hub rejected worker completion (non-fatal).');
                }
              })
              .catch(function (err) {
                console.log('[WorkerComplete] Failed (non-fatal): ' + (err && err.message ? err.message : err));
              });
          }
          taskCompleteResult = { attempted: true, task_id: lastRun.active_task_id, assignment_id: workerAssignmentId, asset_id: resultAssetId, worker: true };
        } catch (e) {
          console.log('[WorkerComplete] Error (non-fatal): ' + e.message);
          taskCompleteResult = { attempted: false, reason: e.message, worker: true };
        }
      } else {
        // Bounty task path: complete via /a2a/task/complete
        try {
          const { completeTask } = require('./taskReceiver');
          const taskId = String(lastRun.active_task_id);
          console.log(`[TaskComplete] Completing task "${lastRun.active_task_title || taskId}" with asset ${resultAssetId}`);
          const completed = completeTask(taskId, resultAssetId);
          if (completed && typeof completed.then === 'function') {
            completed
              .then(function (ok) {
                if (ok) {
                  console.log('[TaskComplete] Task completed successfully on Hub.');
                } else {
                  console.log('[TaskComplete] Hub rejected task completion (non-fatal).');
                }
              })
              .catch(function (err) {
                console.log('[TaskComplete] Failed (non-fatal): ' + (err && err.message ? err.message : err));
              });
          }
          taskCompleteResult = { attempted: true, task_id: taskId, asset_id: resultAssetId };
        } catch (e) {
          console.log('[TaskComplete] Error (non-fatal): ' + e.message);
          taskCompleteResult = { attempted: false, reason: e.message };
        }
      }
    }
  }


  // --- Auto Hub Review: rate fetched assets based on solidify outcome ---
  // When this cycle reused a Hub asset, submit a usage-verified review.
  // The promise is returned so callers can await it before process.exit().
  let hubReviewResult = null;
  let hubReviewPromise = null;
  if (!dryRun && reusedAssetId && (sourceType === 'reused' || sourceType === 'reference')) {
    try {
      const { submitHubReview } = require('./hubReview');
      hubReviewPromise = submitHubReview({
        reusedAssetId: reusedAssetId,
        sourceType: sourceType,
        outcome: event.outcome,
        gene: geneUsed,
        signals: signals,
        blast: blast,
        constraintCheck: constraintCheck,
        runId: lastRun && lastRun.run_id ? lastRun.run_id : null,
      });
      if (hubReviewPromise && typeof hubReviewPromise.then === 'function') {
        hubReviewPromise = hubReviewPromise
          .then(function (r) {
            hubReviewResult = r;
            if (r && r.submitted) {
              console.log('[HubReview] Review submitted successfully (rating=' + r.rating + ').');
            }
            return r;
          })
          .catch(function (err) {
            console.log('[HubReview] Error (non-fatal): ' + (err && err.message ? err.message : err));
            return null;
          });
      }
    } catch (e) {
      console.log('[HubReview] Error (non-fatal): ' + e.message);
    }
  }
  return { ok: success, event, capsule, gene: geneUsed, constraintCheck, validation, validationReport, blast, publishResult, antiPatternPublishResult, taskCompleteResult, hubReviewResult, hubReviewPromise };
}

module.exports = {
  solidify,
  isGitRepo,
  readStateForSolidify,
  writeStateForSolidify,
  isValidationCommandAllowed,
  isCriticalProtectedPath,
  detectDestructiveChanges,
  classifyBlastSeverity,
  analyzeBlastRadiusBreakdown,
  compareBlastEstimate,
  classifyFailureMode,
  adaptGeneFromLearning,
  buildSoftFailureLearningSignals,
  runCanaryCheck,
  applyEpigeneticMarks,
  getEpigeneticBoost,
  buildEpigeneticMark,
  buildSuccessReason,
  BLAST_RADIUS_HARD_CAP_FILES,
  BLAST_RADIUS_HARD_CAP_LINES,
};

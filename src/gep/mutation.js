function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function nowTsMs() {
  return Date.now();
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const s = String(x || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function hasErrorishSignal(signals) {
  const list = Array.isArray(signals) ? signals.map(s => String(s || '')) : [];
  if (list.includes('issue_already_resolved') || list.includes('openclaw_self_healed')) return false;
  if (list.includes('log_error')) return true;
  if (list.some(s => s.startsWith('errsig:') || s.startsWith('errsig_norm:'))) return true;
  return false;
}

// Opportunity signals that indicate a chance to innovate (not just fix).
var OPPORTUNITY_SIGNALS = [
  'user_feature_request',
  'user_improvement_suggestion',
  'perf_bottleneck',
  'capability_gap',
  'stable_success_plateau',
  'external_opportunity',
  'issue_already_resolved',
  'openclaw_self_healed',
  'empty_cycle_loop_detected',
];

function hasOpportunitySignal(signals) {
  var list = Array.isArray(signals) ? signals.map(function (s) { return String(s || ''); }) : [];
  for (var i = 0; i < OPPORTUNITY_SIGNALS.length; i++) {
    if (list.includes(OPPORTUNITY_SIGNALS[i])) return true;
  }
  return false;
}

function mutationCategoryFromContext({ signals, driftEnabled }) {
  if (hasErrorishSignal(signals)) return 'repair';
  if (driftEnabled) return 'innovate';
  // Auto-innovate: opportunity signals present and no errors
  if (hasOpportunitySignal(signals)) return 'innovate';
  // Consult strategy preset: if the configured strategy favors innovation,
  // default to innovate instead of optimize when there is nothing specific to do.
  try {
    var strategy = require('./strategy').resolveStrategy();
    if (strategy && typeof strategy.innovate === 'number' && strategy.innovate >= 0.5) return 'innovate';
  } catch (_) {}
  return 'optimize';
}

function expectedEffectFromCategory(category) {
  const c = String(category || '');
  if (c === 'repair') return 'reduce runtime errors, increase stability, and lower failure rate';
  if (c === 'optimize') return 'improve success rate and reduce repeated operational cost';
  if (c === 'innovate') return 'explore new strategy combinations to escape local optimum';
  return 'improve robustness and success probability';
}

function targetFromGene(selectedGene) {
  if (selectedGene && selectedGene.id) return `gene:${String(selectedGene.id)}`;
  return 'behavior:protocol';
}

function isHighRiskPersonality(p) {
  // Conservative definition: low rigor or high risk_tolerance is treated as high-risk personality.
  const rigor = p && Number.isFinite(Number(p.rigor)) ? Number(p.rigor) : null;
  const riskTol = p && Number.isFinite(Number(p.risk_tolerance)) ? Number(p.risk_tolerance) : null;
  if (rigor != null && rigor < 0.5) return true;
  if (riskTol != null && riskTol > 0.6) return true;
  return false;
}

function isHighRiskMutationAllowed(personalityState) {
  const rigor = personalityState && Number.isFinite(Number(personalityState.rigor)) ? Number(personalityState.rigor) : 0;
  const riskTol =
    personalityState && Number.isFinite(Number(personalityState.risk_tolerance))
      ? Number(personalityState.risk_tolerance)
      : 1;
  return rigor >= 0.6 && riskTol <= 0.5;
}

function buildMutation({
  signals,
  selectedGene,
  driftEnabled,
  personalityState,
  allowHighRisk = false,
  target,
  expected_effect,
} = {}) {
  const ts = nowTsMs();
  const category = mutationCategoryFromContext({ signals, driftEnabled: !!driftEnabled });
  const triggerSignals = uniqStrings(signals);

  const base = {
    type: 'Mutation',
    id: `mut_${ts}`,
    category,
    trigger_signals: triggerSignals,
    target: String(target || targetFromGene(selectedGene)),
    expected_effect: String(expected_effect || expectedEffectFromCategory(category)),
    risk_level: 'low',
  };

  // Default risk assignment: innovate is medium; others low.
  if (category === 'innovate') base.risk_level = 'medium';

  // Optional high-risk escalation (rare, and guarded by strict safety constraints).
  if (allowHighRisk && category === 'innovate') {
    base.risk_level = 'high';
  }

  // Safety constraints (hard):
  // - forbid innovate + high-risk personality (downgrade innovation to optimize)
  // - forbid high-risk mutation unless personality satisfies constraints
  const highRiskPersonality = isHighRiskPersonality(personalityState || null);
  if (base.category === 'innovate' && highRiskPersonality) {
    base.category = 'optimize';
    base.expected_effect = 'safety downgrade: optimize under high-risk personality (avoid innovate+high-risk combo)';
    base.risk_level = 'low';
    base.trigger_signals = uniqStrings([...(base.trigger_signals || []), 'safety:avoid_innovate_with_high_risk_personality']);
  }

  if (base.risk_level === 'high' && !isHighRiskMutationAllowed(personalityState || null)) {
    // Downgrade rather than emit illegal high-risk mutation.
    base.risk_level = 'medium';
    base.trigger_signals = uniqStrings([...(base.trigger_signals || []), 'safety:downgrade_high_risk']);
  }

  return base;
}

function isValidMutation(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'Mutation') return false;
  if (!obj.id || typeof obj.id !== 'string') return false;
  if (!obj.category || !['repair', 'optimize', 'innovate'].includes(String(obj.category))) return false;
  if (!Array.isArray(obj.trigger_signals)) return false;
  if (!obj.target || typeof obj.target !== 'string') return false;
  if (!obj.expected_effect || typeof obj.expected_effect !== 'string') return false;
  if (!obj.risk_level || !['low', 'medium', 'high'].includes(String(obj.risk_level))) return false;
  return true;
}

function normalizeMutation(obj) {
  const m = obj && typeof obj === 'object' ? obj : {};
  const out = {
    type: 'Mutation',
    id: typeof m.id === 'string' ? m.id : `mut_${nowTsMs()}`,
    category: ['repair', 'optimize', 'innovate'].includes(String(m.category)) ? String(m.category) : 'optimize',
    trigger_signals: uniqStrings(m.trigger_signals),
    target: typeof m.target === 'string' ? m.target : 'behavior:protocol',
    expected_effect: typeof m.expected_effect === 'string' ? m.expected_effect : expectedEffectFromCategory(m.category),
    risk_level: ['low', 'medium', 'high'].includes(String(m.risk_level)) ? String(m.risk_level) : 'low',
  };
  return out;
}

module.exports = {
  clamp01,
  buildMutation,
  isValidMutation,
  normalizeMutation,
  isHighRiskMutationAllowed,
  isHighRiskPersonality,
  hasOpportunitySignal,
};


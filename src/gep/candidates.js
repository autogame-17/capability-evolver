function stableHash(input) {
  // Deterministic lightweight hash (not cryptographic).
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function clip(text, maxChars) {
  const s = String(text || '');
  if (!maxChars || s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 20)) + ' ...[TRUNCATED]';
}

function toLines(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean);
}

function extractToolCalls(transcript) {
  const lines = toLines(transcript);
  const calls = [];
  for (const line of lines) {
    // OpenClaw format: [TOOL: Shell]
    const m = line.match(/\[TOOL:\s*([^\]]+)\]/i);
    if (m && m[1]) { calls.push(m[1].trim()); continue; }
    // Cursor transcript format: [Tool call] Shell
    const m2 = line.match(/\[Tool call\]\s+(\S+)/i);
    if (m2 && m2[1]) calls.push(m2[1].trim());
  }
  return calls;
}

function countFreq(items) {
  const map = new Map();
  for (const it of items) map.set(it, (map.get(it) || 0) + 1);
  return map;
}

function buildFiveQuestionsShape({ title, signals, evidence }) {
  // Keep it short and structured; this is a template, not a perfect inference.
  const input = 'Recent session transcript + memory snippets + user instructions';
  const output = 'A safe, auditable evolution patch guided by GEP assets';
  const invariants = 'Protocol order, small reversible patches, validation, append-only events';
  const params = `Signals: ${Array.isArray(signals) ? signals.join(', ') : ''}`.trim();
  const failurePoints = 'Missing signals, over-broad changes, skipped validation, missing knowledge solidification';
  return {
    title: String(title || '').slice(0, 120),
    input,
    output,
    invariants,
    params: params || 'Signals: (none)',
    failure_points: failurePoints,
    evidence: clip(evidence, 240),
  };
}

function extractCapabilityCandidates({ recentSessionTranscript, signals }) {
  const candidates = [];
  const toolCalls = extractToolCalls(recentSessionTranscript);
  const freq = countFreq(toolCalls);

  for (const [tool, count] of freq.entries()) {
    if (count < 2) continue;
    const title = `Repeated tool usage: ${tool}`;
    const evidence = `Observed ${count} occurrences of tool call marker for ${tool}.`;
    const shape = buildFiveQuestionsShape({ title, signals, evidence });
    candidates.push({
      type: 'CapabilityCandidate',
      id: `cand_${stableHash(title)}`,
      title,
      source: 'transcript',
      created_at: new Date().toISOString(),
      signals: Array.isArray(signals) ? signals : [],
      shape,
    });
  }

  // Signals-as-candidates: capture recurring pain points as reusable capability shapes.
  const signalList = Array.isArray(signals) ? signals : [];
  const signalCandidates = [
    // Defensive signals
    { signal: 'log_error', title: 'Repair recurring runtime errors' },
    { signal: 'protocol_drift', title: 'Prevent protocol drift and enforce auditable outputs' },
    { signal: 'windows_shell_incompatible', title: 'Avoid platform-specific shell assumptions (Windows compatibility)' },
    { signal: 'session_logs_missing', title: 'Harden session log detection and fallback behavior' },
    // Opportunity signals (innovation)
    { signal: 'user_feature_request', title: 'Implement user-requested feature' },
    { signal: 'user_improvement_suggestion', title: 'Apply user improvement suggestion' },
    { signal: 'perf_bottleneck', title: 'Resolve performance bottleneck' },
    { signal: 'capability_gap', title: 'Fill capability gap' },
    { signal: 'stable_success_plateau', title: 'Explore new strategies during stability plateau' },
    { signal: 'external_opportunity', title: 'Evaluate external A2A asset for local adoption' },
  ];

  for (const sc of signalCandidates) {
    if (!signalList.some(s => s === sc.signal || s.startsWith(sc.signal + ':'))) continue;
    const evidence = `Signal present: ${sc.signal}`;
    const shape = buildFiveQuestionsShape({ title: sc.title, signals, evidence });
    candidates.push({
      type: 'CapabilityCandidate',
      id: `cand_${stableHash(sc.signal)}`,
      title: sc.title,
      source: 'signals',
      created_at: new Date().toISOString(),
      signals: signalList,
      shape,
    });
  }

  // Dedup by id
  const seen = new Set();
  return candidates.filter(c => {
    if (!c || !c.id) return false;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

function renderCandidatesPreview(candidates, maxChars = 1400) {
  const list = Array.isArray(candidates) ? candidates : [];
  const lines = [];
  for (const c of list) {
    const s = c && c.shape ? c.shape : {};
    lines.push(`- ${c.id}: ${c.title}`);
    lines.push(`  - input: ${s.input || ''}`);
    lines.push(`  - output: ${s.output || ''}`);
    lines.push(`  - invariants: ${s.invariants || ''}`);
    lines.push(`  - params: ${s.params || ''}`);
    lines.push(`  - failure_points: ${s.failure_points || ''}`);
    if (s.evidence) lines.push(`  - evidence: ${s.evidence}`);
  }
  return clip(lines.join('\n'), maxChars);
}

module.exports = {
  extractCapabilityCandidates,
  renderCandidatesPreview,
};


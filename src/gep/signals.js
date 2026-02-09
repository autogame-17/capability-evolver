// Opportunity signal names (shared with mutation.js and personality.js).
var OPPORTUNITY_SIGNALS = [
  'user_feature_request',
  'user_improvement_suggestion',
  'perf_bottleneck',
  'capability_gap',
  'stable_success_plateau',
  'external_opportunity',
  'recurring_error',
  'unsupported_input_type',
];

function hasOpportunitySignal(signals) {
  var list = Array.isArray(signals) ? signals : [];
  for (var i = 0; i < OPPORTUNITY_SIGNALS.length; i++) {
    if (list.includes(OPPORTUNITY_SIGNALS[i])) return true;
  }
  return false;
}

function extractSignals({ recentSessionTranscript, todayLog, memorySnippet, userSnippet }) {
  var signals = [];
  var corpus = [
    String(recentSessionTranscript || ''),
    String(todayLog || ''),
    String(memorySnippet || ''),
    String(userSnippet || ''),
  ].join('\n');
  var lower = corpus.toLowerCase();

  // --- Defensive signals (errors, missing resources) ---

  var errorHit = /\[error|error:|exception|fail|failed|iserror":true/.test(lower);
  if (errorHit) signals.push('log_error');

  // Error signature (more reproducible than a coarse "log_error" tag).
  try {
    var lines = corpus
      .split('\n')
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);

    var errLine =
      lines.find(function (l) { return /\b(typeerror|referenceerror|syntaxerror)\b\s*:|error\s*:|exception\s*:|\[error/i.test(l); }) ||
      null;

    if (errLine) {
      var clipped = errLine.replace(/\s+/g, ' ').slice(0, 260);
      signals.push('errsig:' + clipped);
    }
  } catch (e) {}

  if (lower.includes('memory.md missing')) signals.push('memory_missing');
  if (lower.includes('user.md missing')) signals.push('user_missing');
  if (lower.includes('key missing')) signals.push('integration_key_missing');
  if (lower.includes('no session logs found') || lower.includes('no jsonl files')) signals.push('session_logs_missing');
  if (lower.includes('pgrep') || lower.includes('ps aux')) signals.push('windows_shell_incompatible');
  if (lower.includes('path.resolve(__dirname, \'../../')) signals.push('path_outside_workspace');

  // Protocol-specific drift signals
  if (lower.includes('prompt') && !lower.includes('evolutionevent')) signals.push('protocol_drift');

  // --- Recurring error detection (robustness signals) ---
  // Count repeated identical errors -- these indicate systemic issues that need automated fixes
  try {
    var errorCounts = {};
    var errPatterns = corpus.match(/(?:LLM error|"error"|"status":\s*"error")[^}]{0,200}/gi) || [];
    for (var ep = 0; ep < errPatterns.length; ep++) {
      // Normalize to a short key
      var key = errPatterns[ep].replace(/\s+/g, ' ').slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    var recurringErrors = Object.entries(errorCounts).filter(function (e) { return e[1] >= 3; });
    if (recurringErrors.length > 0) {
      signals.push('recurring_error');
      // Include the top recurring error signature for the agent to diagnose
      var topErr = recurringErrors.sort(function (a, b) { return b[1] - a[1]; })[0];
      signals.push('recurring_errsig(' + topErr[1] + 'x):' + topErr[0].slice(0, 150));
    }
  } catch (e) {}

  // --- Unsupported input type (e.g. GIF, video formats the LLM can't handle) ---
  if (/unsupported mime|unsupported.*type|invalid.*mime/i.test(lower)) {
    signals.push('unsupported_input_type');
  }

  // --- Opportunity signals (innovation / feature requests) ---

  // user_feature_request: user explicitly asks for a new capability
  // Look for action verbs + object patterns that indicate a feature request
  if (/\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,60}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i.test(corpus)) {
    signals.push('user_feature_request');
  }
  // Also catch direct "I want/need X" patterns
  if (/\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower)) {
    signals.push('user_feature_request');
  }

  // user_improvement_suggestion: user suggests making something better
  if (/\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b/i.test(lower)) {
    // Only fire if there is no active error (to distinguish from repair requests)
    if (!errorHit) signals.push('user_improvement_suggestion');
  }

  // perf_bottleneck: performance issues detected
  if (/\b(slow|timeout|timed?\s*out|latency|bottleneck|took too long|performance issue|high cpu|high memory|oom|out of memory)\b/i.test(lower)) {
    signals.push('perf_bottleneck');
  }

  // capability_gap: something is explicitly unsupported or missing
  if (/\b(not supported|cannot|doesn'?t support|no way to|missing feature|unsupported|not available|not implemented|no support for)\b/i.test(lower)) {
    // Only fire if it is not just a missing file/config signal
    if (!signals.includes('memory_missing') && !signals.includes('user_missing') && !signals.includes('session_logs_missing')) {
      signals.push('capability_gap');
    }
  }

  // --- Signal prioritization ---
  // Remove cosmetic signals when actionable signals exist
  var actionable = signals.filter(function (s) {
    return s !== 'user_missing' && s !== 'memory_missing' && s !== 'session_logs_missing' && s !== 'windows_shell_incompatible';
  });
  // If we have actionable signals, drop the cosmetic ones
  if (actionable.length > 0) {
    signals = actionable;
  }

  // If no signals at all, add a default innovation signal
  if (signals.length === 0) {
    signals.push('stable_success_plateau');
  }

  return Array.from(new Set(signals));
}

module.exports = { extractSignals, hasOpportunitySignal, OPPORTUNITY_SIGNALS };

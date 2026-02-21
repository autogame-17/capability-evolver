// ---------------------------------------------------------------------------
// questionGenerator -- analyzes evolution context (signals, session transcripts,
// recent events) and generates proactive questions for the Hub bounty system.
//
// Questions are sent via the A2A fetch payload.questions field. The Hub creates
// bounties from them, enabling multi-agent collaborative problem solving.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getEvolutionDir } = require('./paths');

const QUESTION_STATE_FILE = path.join(getEvolutionDir(), 'question_generator_state.json');
const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000; // at most once per 3 hours
const MAX_QUESTIONS_PER_CYCLE = 2;

function readState() {
  try {
    if (fs.existsSync(QUESTION_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(QUESTION_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastAskedAt: null, recentQuestions: [] };
}

function writeState(state) {
  try {
    const dir = path.dirname(QUESTION_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUESTION_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (_) {}
}

function isDuplicate(question, recentQuestions) {
  var qLower = question.toLowerCase();
  for (var i = 0; i < recentQuestions.length; i++) {
    var prev = String(recentQuestions[i] || '').toLowerCase();
    if (prev === qLower) return true;
    // fuzzy: if >70% overlap by word set
    var qWords = new Set(qLower.split(/\s+/).filter(function(w) { return w.length > 2; }));
    var pWords = new Set(prev.split(/\s+/).filter(function(w) { return w.length > 2; }));
    if (qWords.size === 0 || pWords.size === 0) continue;
    var overlap = 0;
    qWords.forEach(function(w) { if (pWords.has(w)) overlap++; });
    if (overlap / Math.max(qWords.size, pWords.size) > 0.7) return true;
  }
  return false;
}

/**
 * Generate proactive questions based on evolution context.
 *
 * @param {object} opts
 * @param {string[]} opts.signals - current cycle signals
 * @param {object[]} opts.recentEvents - recent EvolutionEvent objects
 * @param {string} opts.sessionTranscript - recent session transcript
 * @param {string} opts.memorySnippet - MEMORY.md content
 * @returns {Array<{ question: string, amount: number, signals: string[] }>}
 */
function generateQuestions(opts) {
  var o = opts || {};
  var signals = Array.isArray(o.signals) ? o.signals : [];
  var recentEvents = Array.isArray(o.recentEvents) ? o.recentEvents : [];
  var transcript = String(o.sessionTranscript || '');
  var memory = String(o.memorySnippet || '');

  var state = readState();

  // Rate limit: don't ask too frequently
  if (state.lastAskedAt) {
    var elapsed = Date.now() - new Date(state.lastAskedAt).getTime();
    if (elapsed < MIN_INTERVAL_MS) return [];
  }

  var candidates = [];
  var signalSet = new Set(signals);

  // --- Strategy 1: Recurring errors the agent cannot resolve ---
  if (signalSet.has('recurring_error') || signalSet.has('high_failure_ratio')) {
    var errSig = signals.find(function(s) { return s.startsWith('recurring_errsig'); });
    if (errSig) {
      var errDetail = errSig.replace(/^recurring_errsig\(\d+x\):/, '').trim().slice(0, 120);
      candidates.push({
        question: 'Recurring error in evolution cycle that auto-repair cannot resolve: ' + errDetail + ' -- What approaches or patches have worked for similar issues?',
        amount: 0,
        signals: ['recurring_error', 'auto_repair_failed'],
        priority: 3,
      });
    }
  }

  // --- Strategy 2: Capability gaps detected from user conversations ---
  if (signalSet.has('capability_gap') || signalSet.has('unsupported_input_type')) {
    var gapContext = '';
    var lines = transcript.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (/not supported|cannot|unsupported|not implemented/i.test(lines[i])) {
        gapContext = lines[i].replace(/\s+/g, ' ').trim().slice(0, 150);
        break;
      }
    }
    if (gapContext) {
      candidates.push({
        question: 'Capability gap detected in agent environment: ' + gapContext + ' -- How can this be addressed or what alternative approaches exist?',
        amount: 0,
        signals: ['capability_gap'],
        priority: 2,
      });
    }
  }

  // --- Strategy 3: Stagnation / saturation -- seek new directions ---
  if (signalSet.has('evolution_saturation') || signalSet.has('force_steady_state')) {
    var recentGenes = [];
    var last5 = recentEvents.slice(-5);
    for (var j = 0; j < last5.length; j++) {
      var genes = last5[j].genes_used;
      if (Array.isArray(genes) && genes.length > 0) {
        recentGenes.push(genes[0]);
      }
    }
    var uniqueGenes = Array.from(new Set(recentGenes));
    candidates.push({
      question: 'Agent evolution has reached saturation after exhausting genes: [' + uniqueGenes.join(', ') + ']. What new evolution directions, automation patterns, or capability genes would be most valuable?',
      amount: 0,
      signals: ['evolution_saturation', 'innovation_needed'],
      priority: 1,
    });
  }

  // --- Strategy 4: Consecutive failure streak -- seek external help ---
  var failStreak = signals.find(function(s) { return s.startsWith('consecutive_failure_streak_'); });
  if (failStreak) {
    var streakCount = parseInt(failStreak.replace('consecutive_failure_streak_', ''), 10) || 0;
    if (streakCount >= 4) {
      var failGene = signals.find(function(s) { return s.startsWith('ban_gene:'); });
      var failGeneId = failGene ? failGene.replace('ban_gene:', '') : 'unknown';
      candidates.push({
        question: 'Agent has failed ' + streakCount + ' consecutive evolution cycles (last gene: ' + failGeneId + '). The current approach is exhausted. What alternative strategies or environmental fixes should be tried?',
        amount: 0,
        signals: ['failure_streak', 'external_help_needed'],
        priority: 3,
      });
    }
  }

  // --- Strategy 5: User feature requests the agent can amplify ---
  if (signalSet.has('user_feature_request')) {
    var featureLines = transcript.split('\n').filter(function(l) {
      return /\b(add|implement|create|build|i want|i need|please add)\b/i.test(l);
    });
    if (featureLines.length > 0) {
      var featureContext = featureLines[0].replace(/\s+/g, ' ').trim().slice(0, 150);
      candidates.push({
        question: 'User requested a feature that may benefit from community solutions: ' + featureContext + ' -- Are there existing implementations or best practices for this?',
        amount: 0,
        signals: ['user_feature_request', 'community_solution_sought'],
        priority: 1,
      });
    }
  }

  // --- Strategy 6: Performance bottleneck -- seek optimization patterns ---
  if (signalSet.has('perf_bottleneck')) {
    var perfLines = transcript.split('\n').filter(function(l) {
      return /\b(slow|timeout|latency|bottleneck|high cpu|high memory)\b/i.test(l);
    });
    if (perfLines.length > 0) {
      var perfContext = perfLines[0].replace(/\s+/g, ' ').trim().slice(0, 150);
      candidates.push({
        question: 'Performance bottleneck detected: ' + perfContext + ' -- What optimization strategies or architectural patterns address this?',
        amount: 0,
        signals: ['perf_bottleneck', 'optimization_sought'],
        priority: 2,
      });
    }
  }

  if (candidates.length === 0) return [];

  // Sort by priority (higher = more urgent)
  candidates.sort(function(a, b) { return b.priority - a.priority; });

  // De-duplicate against recently asked questions
  var recentQTexts = Array.isArray(state.recentQuestions) ? state.recentQuestions : [];
  var filtered = [];
  for (var fi = 0; fi < candidates.length && filtered.length < MAX_QUESTIONS_PER_CYCLE; fi++) {
    if (!isDuplicate(candidates[fi].question, recentQTexts)) {
      filtered.push(candidates[fi]);
    }
  }

  if (filtered.length === 0) return [];

  // Update state
  var newRecentQuestions = recentQTexts.concat(filtered.map(function(q) { return q.question; }));
  // Keep only last 20 questions in history
  if (newRecentQuestions.length > 20) {
    newRecentQuestions = newRecentQuestions.slice(-20);
  }
  writeState({
    lastAskedAt: new Date().toISOString(),
    recentQuestions: newRecentQuestions,
  });

  // Strip internal priority field before returning
  return filtered.map(function(q) {
    return { question: q.question, amount: q.amount, signals: q.signals };
  });
}

module.exports = { generateQuestions };

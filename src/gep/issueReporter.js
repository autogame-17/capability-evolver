// Automatic GitHub issue reporter for recurring evolver failures.
// When the evolver hits persistent errors (failure streaks, recurring errors),
// this module files a GitHub issue with sanitized logs and environment info.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getEvolutionDir } = require('./paths');
const { captureEnvFingerprint } = require('./envFingerprint');
const { redactString } = require('./sanitize');
const { getNodeId } = require('./a2aProtocol');

const STATE_FILE_NAME = 'issue_reporter_state.json';
const DEFAULT_REPO = 'autogame-17/evolver';
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_STREAK = 5;
const MAX_LOG_CHARS = 2000;
const MAX_EVENTS = 5;

function getConfig() {
  var enabled = String(process.env.EVOLVER_AUTO_ISSUE || 'true').toLowerCase();
  if (enabled === 'false' || enabled === '0') return null;
  return {
    repo: process.env.EVOLVER_ISSUE_REPO || DEFAULT_REPO,
    cooldownMs: Number(process.env.EVOLVER_ISSUE_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS,
    minStreak: Number(process.env.EVOLVER_ISSUE_MIN_STREAK) || DEFAULT_MIN_STREAK,
  };
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || '';
}

function getStatePath() {
  return path.join(getEvolutionDir(), STATE_FILE_NAME);
}

function readState() {
  try {
    var p = getStatePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return { lastReportedAt: null, recentIssueKeys: [] };
}

function writeState(state) {
  try {
    var dir = getEvolutionDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2) + '\n');
  } catch (_) {}
}

function truncateNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return 'unknown';
  if (nodeId.length <= 10) return nodeId;
  return nodeId.slice(0, 10) + '...';
}

function computeErrorKey(signals) {
  var relevant = signals
    .filter(function (s) {
      return s.startsWith('recurring_errsig') ||
        s.startsWith('ban_gene:') ||
        s === 'recurring_error' ||
        s === 'failure_loop_detected' ||
        s === 'high_failure_ratio';
    })
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(relevant || 'unknown').digest('hex').slice(0, 16);
}

function extractErrorSignature(signals) {
  var errSig = signals.find(function (s) { return s.startsWith('recurring_errsig'); });
  if (errSig) {
    return errSig.replace(/^recurring_errsig\(\d+x\):/, '').trim().slice(0, 200);
  }
  var banned = signals.find(function (s) { return s.startsWith('ban_gene:'); });
  if (banned) return 'Repeated failures with gene: ' + banned.replace('ban_gene:', '');
  return 'Persistent evolution failure';
}

function extractStreakCount(signals) {
  for (var i = 0; i < signals.length; i++) {
    if (signals[i].startsWith('consecutive_failure_streak_')) {
      var n = parseInt(signals[i].replace('consecutive_failure_streak_', ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function formatRecentEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '_No recent events available._';
  var failed = events.filter(function (e) { return e && e.outcome && e.outcome.status === 'failed'; });
  var rows = failed.slice(-MAX_EVENTS).map(function (e, idx) {
    var intent = e.intent || '-';
    var gene = (Array.isArray(e.genes_used) && e.genes_used[0]) || '-';
    var outcome = (e.outcome && e.outcome.status) || '-';
    var reason = (e.outcome && e.outcome.reason) || '';
    if (reason.length > 80) reason = reason.slice(0, 80) + '...';
    reason = redactString(reason);
    return '| ' + (idx + 1) + ' | ' + intent + ' | ' + gene + ' | ' + outcome + ' | ' + reason + ' |';
  });
  if (rows.length === 0) return '_No failed events in recent history._';
  return '| # | Intent | Gene | Outcome | Reason |\n|---|--------|------|---------|--------|\n' + rows.join('\n');
}

function buildIssueBody(opts) {
  var fp = opts.envFingerprint || captureEnvFingerprint();
  var signals = opts.signals || [];
  var recentEvents = opts.recentEvents || [];
  var sessionLog = opts.sessionLog || '';
  var streakCount = extractStreakCount(signals);
  var errorSig = extractErrorSignature(signals);
  var nodeId = truncateNodeId(getNodeId());

  var failureSignals = signals.filter(function (s) {
    return s.startsWith('recurring_') ||
      s.startsWith('consecutive_failure') ||
      s.startsWith('failure_loop') ||
      s.startsWith('high_failure') ||
      s.startsWith('ban_gene:') ||
      s === 'force_innovation_after_repair_loop';
  }).join(', ');

  var sanitizedLog = redactString(
    typeof sessionLog === 'string' ? sessionLog.slice(-MAX_LOG_CHARS) : ''
  );

  var eventsTable = formatRecentEvents(recentEvents);

  var reportId = crypto.createHash('sha256')
    .update(nodeId + '|' + Date.now() + '|' + errorSig)
    .digest('hex').slice(0, 12);

  var body = [
    '## Environment',
    '- **Evolver Version:** ' + (fp.evolver_version || 'unknown'),
    '- **Node.js:** ' + (fp.node_version || process.version),
    '- **Platform:** ' + (fp.platform || process.platform) + ' ' + (fp.arch || process.arch),
    '- **Container:** ' + (fp.container ? 'yes' : 'no'),
    '',
    '## Failure Summary',
    '- **Consecutive failures:** ' + (streakCount || 'N/A'),
    '- **Failure signals:** ' + (failureSignals || 'none'),
    '',
    '## Error Signature',
    '```',
    redactString(errorSig),
    '```',
    '',
    '## Recent Evolution Events (sanitized)',
    eventsTable,
    '',
    '## Session Log Excerpt (sanitized)',
    '```',
    sanitizedLog || '_No session log available._',
    '```',
    '',
    '---',
    '_This issue was automatically created by evolver v' + (fp.evolver_version || 'unknown') + '._',
    '_Device: ' + nodeId + ' | Report ID: ' + reportId + '_',
  ];

  return body.join('\n');
}

function shouldReport(signals, config) {
  if (!config) return false;

  var hasFailureLoop = signals.includes('failure_loop_detected');
  var hasRecurringAndHigh = signals.includes('recurring_error') && signals.includes('high_failure_ratio');

  if (!hasFailureLoop && !hasRecurringAndHigh) return false;

  var streakCount = extractStreakCount(signals);
  if (streakCount > 0 && streakCount < config.minStreak) return false;

  var state = readState();
  var errorKey = computeErrorKey(signals);

  if (state.lastReportedAt) {
    var elapsed = Date.now() - new Date(state.lastReportedAt).getTime();
    if (elapsed < config.cooldownMs) {
      var recentKeys = Array.isArray(state.recentIssueKeys) ? state.recentIssueKeys : [];
      if (recentKeys.includes(errorKey)) {
        return false;
      }
    }
  }

  return true;
}

async function createGithubIssue(repo, title, body, token) {
  var url = 'https://api.github.com/repos/' + repo + '/issues';
  var response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title: title, body: body }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    var errText = '';
    try { errText = await response.text(); } catch (_) {}
    throw new Error('GitHub API ' + response.status + ': ' + errText.slice(0, 200));
  }

  var data = await response.json();
  return { number: data.number, url: data.html_url };
}

async function maybeReportIssue(opts) {
  var config = getConfig();
  if (!config) return;

  var signals = opts.signals || [];

  if (!shouldReport(signals, config)) return;

  var token = getGithubToken();
  if (!token) {
    console.log('[IssueReporter] No GitHub token available. Skipping auto-report.');
    return;
  }

  var errorSig = extractErrorSignature(signals);
  var titleSig = errorSig.slice(0, 80);
  var title = '[Auto] Recurring failure: ' + titleSig;
  var body = buildIssueBody(opts);

  try {
    var result = await createGithubIssue(config.repo, title, body, token);
    console.log('[IssueReporter] Created GitHub issue #' + result.number + ': ' + result.url);

    var state = readState();
    var errorKey = computeErrorKey(signals);
    var recentKeys = Array.isArray(state.recentIssueKeys) ? state.recentIssueKeys : [];
    recentKeys.push(errorKey);
    if (recentKeys.length > 20) recentKeys = recentKeys.slice(-20);
    writeState({
      lastReportedAt: new Date().toISOString(),
      recentIssueKeys: recentKeys,
      lastIssueUrl: result.url,
      lastIssueNumber: result.number,
    });
  } catch (e) {
    console.log('[IssueReporter] Failed to create issue (non-fatal): ' + (e && e.message ? e.message : String(e)));
  }
}

module.exports = { maybeReportIssue, buildIssueBody, shouldReport };

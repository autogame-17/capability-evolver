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
const { SELF_PR_REPO } = require('../config');

const STATE_FILE_NAME = 'issue_reporter_state.json';
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_STREAK = 5;
const MAX_LOG_CHARS = 2000;
const MAX_EVENTS = 5;
const PRIVATE_FILE_MODE = 0o600;

function isIssueLogInclusionEnabled() {
  const raw = String(process.env.EVOLVER_ISSUE_INCLUDE_LOGS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getConfig() {
  const enabled = String(process.env.EVOLVER_AUTO_ISSUE || 'true').toLowerCase();
  if (enabled === 'false' || enabled === '0') return null;
  return {
    // Default repo is shared with self-PR (see config.SELF_PR_REPO) so that
    // auto-reported issues and auto-filed PRs land in the same public repo.
    repo: process.env.EVOLVER_ISSUE_REPO || SELF_PR_REPO,
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
    const p = getStatePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return { lastReportedAt: null, recentIssueKeys: [] };
}

function writeState(state) {
  try {
    const dir = getEvolutionDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = getStatePath();
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, PRIVATE_FILE_MODE); } catch (_) {}
  } catch (_) {}
}

function redactNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return 'unknown';
  return 'node:' + crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 12);
}

function selectSafeFingerprint(fp) {
  const raw = fp && typeof fp === 'object' ? fp : {};
  return {
    evolver_version: raw.evolver_version || 'unknown',
    node_version: raw.node_version || process.version,
    platform: raw.platform || process.platform,
    arch: raw.arch || process.arch,
    container: !!raw.container,
  };
}

function computeErrorKey(signals) {
  const relevant = signals
    .filter(function (s) {
      return s.startsWith('recurring_errsig') ||
        s.startsWith('ban_gene:') ||
        s === 'recurring_error' ||
        s === 'failure_loop_detected' ||
        s === 'high_failure_ratio';
    })
    .map(function (s) {
      return s.replace(/^recurring_errsig\(\d+x\):/, 'recurring_errsig:');
    })
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(relevant || 'unknown').digest('hex').slice(0, 16);
}

function extractErrorSignature(signals) {
  const errSig = signals.find(function (s) { return s.startsWith('recurring_errsig'); });
  if (errSig) {
    return errSig.replace(/^recurring_errsig\(\d+x\):/, '').trim().slice(0, 200);
  }
  const banned = signals.find(function (s) { return s.startsWith('ban_gene:'); });
  if (banned) return 'Repeated failures with gene: ' + banned.replace('ban_gene:', '');
  return 'Persistent evolution failure';
}

function extractStreakCount(signals) {
  for (let i = 0; i < signals.length; i++) {
    if (signals[i].startsWith('consecutive_failure_streak_')) {
      const n = parseInt(signals[i].replace('consecutive_failure_streak_', ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function formatRecentEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '_No recent events available._';
  const failed = events.filter(function (e) { return e && e.outcome && e.outcome.status === 'failed'; });
  const rows = failed.slice(-MAX_EVENTS).map(function (e, idx) {
    const intent = redactString(String(e.intent || '-')).slice(0, 80);
    const gene = redactString(String((Array.isArray(e.genes_used) && e.genes_used[0]) || '-')).slice(0, 80);
    const outcome = (e.outcome && e.outcome.status) || '-';
    let reason = (e.outcome && e.outcome.reason) || '';
    if (reason.length > 80) reason = reason.slice(0, 80) + '...';
    reason = redactString(reason);
    return '| ' + (idx + 1) + ' | ' + intent + ' | ' + gene + ' | ' + outcome + ' | ' + reason + ' |';
  });
  if (rows.length === 0) return '_No failed events in recent history._';
  return '| # | Intent | Gene | Outcome | Reason |\n|---|--------|------|---------|--------|\n' + rows.join('\n');
}

function buildIssueBody(opts) {
  const fp = selectSafeFingerprint(opts.envFingerprint || captureEnvFingerprint());
  const signals = opts.signals || [];
  const recentEvents = opts.recentEvents || [];
  const sessionLog = opts.sessionLog || '';
  const streakCount = extractStreakCount(signals);
  const errorSig = extractErrorSignature(signals);
  const nodeId = redactNodeId(getNodeId());

  const failureSignals = signals.filter(function (s) {
    return s.startsWith('recurring_') ||
      s.startsWith('consecutive_failure') ||
      s.startsWith('failure_loop') ||
      s.startsWith('high_failure') ||
      s.startsWith('ban_gene:') ||
      s === 'force_innovation_after_repair_loop';
  }).join(', ');

  const sanitizedLog = isIssueLogInclusionEnabled()
    ? redactString(typeof sessionLog === 'string' ? sessionLog.slice(-MAX_LOG_CHARS) : '')
    : '';

  const eventsTable = formatRecentEvents(recentEvents);

  const reportId = crypto.createHash('sha256')
    .update(nodeId + '|' + Date.now() + '|' + errorSig)
    .digest('hex').slice(0, 12);

  const body = [
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
    sanitizedLog ? '```' : '',
    sanitizedLog || '_Log excerpt omitted by default. Set EVOLVER_ISSUE_INCLUDE_LOGS=true to include sanitized logs._',
    sanitizedLog ? '```' : '',
    sanitizedLog ? '' : '',
    '---',
    '_This issue was automatically created by evolver v' + (fp.evolver_version || 'unknown') + '._',
    '_Device: ' + nodeId + ' | Report ID: ' + reportId + '_',
  ];

  return body.join('\n');
}

function shouldReport(signals, config) {
  if (!config) return false;

  const hasFailureLoop = signals.includes('failure_loop_detected');
  const hasRecurringAndHigh = signals.includes('recurring_error') && signals.includes('high_failure_ratio');

  if (!hasFailureLoop && !hasRecurringAndHigh) return false;

  const streakCount = extractStreakCount(signals);
  if (streakCount < config.minStreak) return false;

  const state = readState();
  const errorKey = computeErrorKey(signals);

  if (state.lastReportedAt) {
    const elapsed = Date.now() - new Date(state.lastReportedAt).getTime();
    if (elapsed < config.cooldownMs) {
      const recentKeys = Array.isArray(state.recentIssueKeys) ? state.recentIssueKeys : [];
      if (recentKeys.includes(errorKey)) {
        return false;
      }
    }
  }

  return true;
}

async function createGithubIssue(repo, title, body, token) {
  const url = 'https://api.github.com/repos/' + repo + '/issues';
  const response = await fetch(url, {
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
    let errText = '';
    try { errText = await response.text(); } catch (_) {}
    throw new Error('GitHub API ' + response.status + ': ' + errText.slice(0, 200));
  }

  const data = await response.json();
  return { number: data.number, url: data.html_url };
}

function escapeSearchQuery(s) {
  return String(s || '').replace(/"/g, '').replace(/[\r\n]+/g, ' ').trim();
}

async function findExistingIssue(repo, title, token) {
  const titleSig = escapeSearchQuery(title).slice(0, 120);
  if (!titleSig) return null;
  const q = 'repo:' + repo + ' is:issue is:open in:title "' + titleSig + '"';
  const url = 'https://api.github.com/search/issues?per_page=5&q=' + encodeURIComponent(q);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: headers, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return null;
  }
  if (!response.ok) return null;
  let data;
  try { data = await response.json(); } catch (_) { return null; }
  const items = Array.isArray(data && data.items) ? data.items : [];
  const AUTO_PREFIX = '[Auto] Recurring failure: ';
  const match = items.find(function (it) {
    return it && typeof it.title === 'string' && it.title.trim() === title.trim() && it.state === 'open';
  }) || items.find(function (it) {
    return it && it.state === 'open' && typeof it.title === 'string' &&
      it.title.startsWith(AUTO_PREFIX) && it.title.trim().startsWith(titleSig.trim());
  });
  if (!match) return null;
  return { number: match.number, url: match.html_url, title: match.title };
}

async function maybeReportIssue(opts) {
  const config = getConfig();
  if (!config) return;

  const signals = opts.signals || [];

  if (!shouldReport(signals, config)) return;

  const token = getGithubToken();
  if (!token) {
    console.log('[IssueReporter] No GitHub token available. Skipping auto-report.');
    return;
  }

  const errorSig = extractErrorSignature(signals);
  const titleSig = errorSig.slice(0, 80);
  const title = '[Auto] Recurring failure: ' + titleSig;
  const body = buildIssueBody(opts);

  try {
    const existing = await findExistingIssue(config.repo, title, token);
    if (existing) {
      console.log('[IssueReporter] Open issue already exists (#' + existing.number + '): ' + existing.url + '. Skipping duplicate report.');
      const state = readState();
      const errorKey = computeErrorKey(signals);
      let recentKeys = Array.isArray(state.recentIssueKeys) ? state.recentIssueKeys : [];
      if (!recentKeys.includes(errorKey)) recentKeys.push(errorKey);
      if (recentKeys.length > 20) recentKeys = recentKeys.slice(-20);
      writeState({
        lastReportedAt: state.lastReportedAt || null,
        recentIssueKeys: recentKeys,
        lastIssueUrl: existing.url,
        lastIssueNumber: existing.number,
        lastSkippedAt: new Date().toISOString(),
      });
      return;
    }

    const result = await createGithubIssue(config.repo, title, body, token);
    console.log('[IssueReporter] Created GitHub issue #' + result.number + ': ' + result.url);

    const state = readState();
    const errorKey = computeErrorKey(signals);
    let recentKeys = Array.isArray(state.recentIssueKeys) ? state.recentIssueKeys : [];
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

module.exports = {
  maybeReportIssue,
  buildIssueBody,
  shouldReport,
  findExistingIssue,
  getConfig,
  computeErrorKey,
  extractStreakCount,
  extractErrorSignature,
};

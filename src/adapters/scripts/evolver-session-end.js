#!/usr/bin/env node
// evolver-session-end.js
// Records evolution outcome at session end.
// Collects git diff stats, extracts signals, records via Hub API or local memory.
// Input: stdin JSON. Output: stdout JSON with followup_message.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

function findEvolverRoot() {
  const candidates = [
    process.env.EVOLVER_ROOT,
    path.resolve(__dirname, '..', '..', '..'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'));
        if (pkg.name === '@evomap/evolver' || pkg.name === 'evolver') return c;
      } catch { /* skip */ }
    }
  }
  const homeSkills = path.join(require('os').homedir(), 'skills', 'evolver');
  if (fs.existsSync(path.join(homeSkills, 'package.json'))) return homeSkills;
  return null;
}

function findMemoryGraph(evolverRoot) {
  if (process.env.MEMORY_GRAPH_PATH && fs.existsSync(process.env.MEMORY_GRAPH_PATH)) {
    return process.env.MEMORY_GRAPH_PATH;
  }
  const candidates = [
    evolverRoot && path.join(evolverRoot, 'memory', 'evolution', 'memory_graph.jsonl'),
    evolverRoot && path.join(evolverRoot, 'MEMORY', 'evolution', 'memory_graph.jsonl'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  if (evolverRoot) {
    const defaultPath = path.join(evolverRoot, 'memory', 'evolution', 'memory_graph.jsonl');
    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    return defaultPath;
  }
  return null;
}

function getGitDiffStats() {
  try {
    const cwd = process.cwd();
    const stat = execSync('git diff --stat HEAD~1 2>/dev/null || git diff --stat 2>/dev/null || echo ""', {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const diffContent = execSync('git diff HEAD~1 --no-color 2>/dev/null || git diff --no-color 2>/dev/null || echo ""', {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const filesChanged = (stat.match(/\d+ files? changed/) || ['0'])[0];
    const insertions = (stat.match(/(\d+) insertions?/) || [null, '0'])[1];
    const deletions = (stat.match(/(\d+) deletions?/) || [null, '0'])[1];
    return {
      stat,
      summary: `${filesChanged}, +${insertions}/-${deletions}`,
      diffSnippet: diffContent.slice(0, 2000),
      hasChanges: stat.length > 0,
    };
  } catch {
    return { stat: '', summary: 'unknown', diffSnippet: '', hasChanges: false };
  }
}

function detectSignals(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const signals = [];
  if (/error:|exception:|failed/i.test(lower)) signals.push('log_error');
  if (/timeout|slow|latency|bottleneck/i.test(lower)) signals.push('perf_bottleneck');
  if (/add|implement|feature|new function|new module/i.test(lower)) signals.push('user_feature_request');
  if (/improve|enhance|refactor|optimize/i.test(lower)) signals.push('user_improvement_suggestion');
  if (/not supported|unsupported|not implemented/i.test(lower)) signals.push('capability_gap');
  if (/deploy|ci|pipeline|build failed/i.test(lower)) signals.push('deployment_issue');
  if (/test fail|assertion|expect\(/i.test(lower)) signals.push('test_failure');
  return [...new Set(signals)];
}

function recordToHub(outcome) {
  const hubUrl = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL;
  const apiKey = process.env.EVOMAP_API_KEY || process.env.A2A_NODE_SECRET;
  const nodeId = process.env.EVOMAP_NODE_ID || process.env.A2A_NODE_ID;
  if (!hubUrl || !apiKey) return false;

  try {
    const payload = JSON.stringify({
      gene_id: outcome.geneId || 'ad_hoc',
      signals: outcome.signals,
      status: outcome.status,
      score: outcome.score,
      summary: outcome.summary,
      sender_id: nodeId || undefined,
    });
    // Argv-array form avoids shell interpretation of apiKey, payload, or the
    // hub URL. Values cannot break out through quoting metacharacters.
    const res = spawnSync('curl', [
      '-s', '-m', '8', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-d', payload,
      `${hubUrl.replace(/\/+$/, '')}/a2a/evolution/record`,
    ], { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    if (res.status !== 0 || res.error) return false;
    return true;
  } catch {
    return false;
  }
}

function recordToLocal(graphPath, outcome) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      gene_id: outcome.geneId || 'ad_hoc',
      signals: outcome.signals,
      outcome: {
        status: outcome.status,
        score: outcome.score,
        note: outcome.summary,
      },
      source: 'hook:session-end',
    };
    fs.appendFileSync(graphPath, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function main() {
  let inputData = '';
  let handled = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { inputData += chunk; });
  process.stdin.on('end', () => {
    if (handled) return;
    handled = true;
    try {
      const diffInfo = getGitDiffStats();

      if (!diffInfo.hasChanges) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const signals = detectSignals(diffInfo.diffSnippet);
      if (signals.length === 0) signals.push('stable_success_plateau');

      const hasErrors = signals.includes('log_error') || signals.includes('test_failure');
      const status = hasErrors ? 'failed' : 'success';
      const score = hasErrors ? 0.3 : 0.8;

      const outcome = {
        geneId: 'ad_hoc',
        signals,
        status,
        score,
        summary: `Session end: ${diffInfo.summary}. Signals: [${signals.join(', ')}]`,
      };

      const evolverRoot = findEvolverRoot();
      const graphPath = findMemoryGraph(evolverRoot);

      const hubOk = recordToHub(outcome);
      const localOk = graphPath ? recordToLocal(graphPath, outcome) : false;

      const target = hubOk ? 'Hub' : localOk ? 'local memory' : 'nowhere (no Hub or local path)';
      const msg = `[Evolution] Session outcome recorded to ${target}: ${outcome.summary}`;

      process.stdout.write(JSON.stringify({
        followup_message: msg,
        stopMessage: msg,
        additionalContext: msg,
      }));
    } catch (e) {
      process.stdout.write(JSON.stringify({}));
    }
  });

  setTimeout(() => {
    if (handled) return;
    handled = true;
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }, 7000);
}

main();

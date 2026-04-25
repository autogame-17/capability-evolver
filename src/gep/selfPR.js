// Self-PR: auto-contribute high-confidence self-mutations back to the public repo.
// When evolver optimizes its own code and the change passes all gates (score, streak,
// blast radius, leak scan, non-obfuscated files only), this module creates a PR on
// the configured public GitHub repo via the `gh` CLI.
//
// Safety: env-gated (EVOLVER_SELF_PR=true), 24h cooldown, diff dedup,
// never auto-merges, only `optimize` + `low` risk mutations qualify.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
// 10 MB — prevents RangeError on large child process output (e.g. git log/diff
// on large repos). See GHSA reports / issue #451.
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

const { getEvolutionDir, getRepoRoot } = require('./paths');
const { fullLeakCheck, redactString } = require('./sanitize');
const {
  SELF_PR_MIN_SCORE,
  SELF_PR_MIN_STREAK,
  SELF_PR_MAX_FILES,
  SELF_PR_MAX_LINES,
  SELF_PR_COOLDOWN_MS,
  SELF_PR_REPO,
  SELF_PR_TIMEOUT_MS,
} = require('../config');

const STATE_FILE = 'self_pr_state.json';

// Files obfuscated in public.manifest.json -- PRs touching these are meaningless.
const OBFUSCATED_FILES = new Set([
  'src/evolve.js',
  'src/gep/selector.js',
  'src/gep/mutation.js',
  'src/gep/solidify.js',
  'src/gep/prompt.js',
  'src/gep/candidates.js',
  'src/gep/reflection.js',
  'src/gep/narrativeMemory.js',
  'src/gep/curriculum.js',
  'src/gep/personality.js',
  'src/gep/learningSignals.js',
  'src/gep/memoryGraph.js',
  'src/gep/memoryGraphAdapter.js',
  'src/gep/strategy.js',
  'src/gep/candidateEval.js',
  'src/gep/hubVerify.js',
  'src/gep/crypto.js',
  'src/gep/contentHash.js',
  'src/gep/a2aProtocol.js',
  'src/gep/hubSearch.js',
  'src/gep/hubReview.js',
  'src/gep/policyCheck.js',
  'src/gep/deviceId.js',
  'src/gep/envFingerprint.js',
  'src/gep/skillDistiller.js',
  'src/gep/explore.js',
  'src/gep/integrityCheck.js',
  'src/gep/shield.js',
]);

// Files that are included in the public manifest (superset patterns).
const PUBLIC_INCLUDE_PREFIXES = ['src/', 'scripts/'];
const PUBLIC_INCLUDE_EXACT = new Set(['index.js', 'package.json']);
const PUBLIC_EXCLUDE_PREFIXES = ['docs/', 'memory/', 'dist-public/'];

function normalizeRel(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isPublicNonObfuscated(filePath) {
  const rel = normalizeRel(filePath);
  if (!rel) return false;
  if (OBFUSCATED_FILES.has(rel)) return false;
  for (const excl of PUBLIC_EXCLUDE_PREFIXES) {
    if (rel.startsWith(excl)) return false;
  }
  if (PUBLIC_INCLUDE_EXACT.has(rel)) return true;
  for (const incl of PUBLIC_INCLUDE_PREFIXES) {
    if (rel.startsWith(incl)) return true;
  }
  return false;
}

function getStatePath() {
  return path.join(getEvolutionDir(), STATE_FILE);
}

function readState() {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return { lastPRAt: null, recentDiffHashes: [] };
}

function writeState(state) {
  try {
    const dir = getEvolutionDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2) + '\n');
  } catch (e) { console.warn('[SelfPR] Failed to save state:', e.message); }
}

function isInCooldown() {
  const state = readState();
  if (!state.lastPRAt) return false;
  const elapsed = Date.now() - new Date(state.lastPRAt).getTime();
  return elapsed < SELF_PR_COOLDOWN_MS;
}

function computeDiffHash(changedFiles, repoRoot) {
  const diffParts = [];
  for (const f of changedFiles) {
    const abs = path.join(repoRoot, f);
    try {
      if (fs.existsSync(abs)) {
        diffParts.push(f + ':' + fs.readFileSync(abs, 'utf8'));
      }
    } catch (_) {}
  }
  return crypto.createHash('sha256').update(diffParts.join('\n---\n')).digest('hex').slice(0, 16);
}

function isDuplicateDiff(diffHash) {
  const state = readState();
  const recent = Array.isArray(state.recentDiffHashes) ? state.recentDiffHashes : [];
  return recent.includes(diffHash);
}

function recordPR(diffHash) {
  const state = readState();
  let recent = Array.isArray(state.recentDiffHashes) ? state.recentDiffHashes : [];
  recent.push(diffHash);
  if (recent.length > 20) recent = recent.slice(-20);
  writeState({
    lastPRAt: new Date().toISOString(),
    recentDiffHashes: recent,
  });
}

function buildPRBody({ capsule, mutation, gene, blastRadius }) {
  const score = capsule && capsule.outcome ? capsule.outcome.score : 0;
  const streak = capsule ? capsule.success_streak : 0;
  const capsuleId = capsule ? capsule.id : 'unknown';
  const geneId = gene ? gene.id : 'unknown';
  const signals = capsule && Array.isArray(capsule.trigger)
    ? capsule.trigger.slice(0, 5).join(', ')
    : '';
  const category = mutation ? mutation.category : 'unknown';
  const risk = mutation ? mutation.risk : 'unknown';
  const rationale = mutation && mutation.rationale
    ? redactString(String(mutation.rationale).slice(0, 500))
    : '';
  const files = blastRadius && Array.isArray(blastRadius.all_changed_files)
    ? blastRadius.all_changed_files.map(normalizeRel)
    : [];
  const filesStr = files.map(function (f) { return '- `' + f + '`'; }).join('\n');

  return [
    '## Mutation Summary',
    '',
    '- **Category:** ' + category,
    '- **Risk:** ' + risk,
    '- **PRM Score:** ' + (typeof score === 'number' ? score.toFixed(3) : String(score)),
    '- **Success Streak:** ' + streak,
    '- **Gene:** `' + geneId + '`',
    '- **Signals:** ' + (signals || 'none'),
    '- **Capsule:** `' + capsuleId + '`',
    '',
    '## Rationale',
    '',
    rationale || '_No rationale provided._',
    '',
    '## Changed Files',
    '',
    filesStr || '_None._',
    '',
    '## Blast Radius',
    '',
    '- Files: ' + (blastRadius ? blastRadius.files : 0),
    '- Lines: ' + (blastRadius ? blastRadius.lines : 0),
    '',
    '---',
    '',
    '_This PR was auto-generated by evolver self-evolution (GEP)._',
    '_Capsule: ' + capsuleId + ' | Gene: ' + geneId + '_',
  ].join('\n');
}

function buildPRTitle(mutation) {
  const rationale = mutation && mutation.rationale
    ? String(mutation.rationale).replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
    : 'self-optimization';
  return '[Auto-Mutation] ' + rationale;
}

function runGh(args, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || SELF_PR_TIMEOUT_MS;
  const cwd = (opts && opts.cwd) || getRepoRoot();
  try {
    const result = execSync('gh ' + args, {
      cwd: cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env), maxBuffer: MAX_EXEC_BUFFER
    });
    return { ok: true, out: String(result || '').trim() };
  } catch (e) {
    return { ok: false, out: '', err: String(e && e.stderr ? e.stderr : e.message || e).slice(0, 500) };
  }
}

function getGitDiff(changedFiles, repoRoot) {
  const parts = [];
  for (const f of changedFiles) {
    const before = parts.length;
    try {
      const result = execSync(
        'git diff HEAD -- "' + f + '"',
        { cwd: repoRoot, timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_EXEC_BUFFER }
      );
      if (result && result.trim()) parts.push(result.trim());
    } catch (e) { console.warn('[SelfPR] Summary method failed:', e.message); }
    if (parts.length === before) {
      try {
        const result = execSync(
          'git diff -- "' + f + '"',
          { cwd: repoRoot, timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_EXEC_BUFFER }
        );
        if (result && result.trim()) parts.push(result.trim());
      } catch (e) { console.warn('[SelfPR] Fallback summary failed:', e.message); }
    }
  }
  return parts.join('\n');
}

async function maybeCreatePR({ capsule, event, mutation, gene, blastRadius }) {
  if (String(process.env.EVOLVER_SELF_PR || '').toLowerCase() !== 'true') return null;

  const score = capsule && capsule.outcome ? (capsule.outcome.score || 0) : 0;
  const streak = capsule ? (capsule.success_streak || 0) : 0;

  if (score < SELF_PR_MIN_SCORE) return null;
  if (streak < SELF_PR_MIN_STREAK) return null;

  if (!mutation || mutation.category !== 'optimize') return null;
  if (!mutation || mutation.risk !== 'low') return null;

  const filesChanged = blastRadius ? (blastRadius.files || 0) : 0;
  const linesChanged = blastRadius ? (blastRadius.lines || 0) : 0;
  if (filesChanged > SELF_PR_MAX_FILES || filesChanged === 0) return null;
  if (linesChanged > SELF_PR_MAX_LINES || linesChanged === 0) return null;

  const changedFiles = (blastRadius && Array.isArray(blastRadius.all_changed_files)
    ? blastRadius.all_changed_files
    : []).map(normalizeRel).filter(Boolean);

  if (changedFiles.length === 0) return null;
  if (!changedFiles.every(isPublicNonObfuscated)) return null;

  if (isInCooldown()) {
    console.log('[SelfPR] Skipping: cooldown active.');
    return { attempted: false, reason: 'cooldown' };
  }

  const repoRoot = getRepoRoot();
  const diffHash = computeDiffHash(changedFiles, repoRoot);
  if (isDuplicateDiff(diffHash)) {
    console.log('[SelfPR] Skipping: duplicate diff ' + diffHash);
    return { attempted: false, reason: 'duplicate_diff' };
  }

  const diffContent = getGitDiff(changedFiles, repoRoot);
  if (!diffContent) {
    console.log('[SelfPR] Skipping: no diff content.');
    return { attempted: false, reason: 'no_diff' };
  }
  const leakResult = fullLeakCheck(diffContent);
  if (leakResult.found) {
    const leakSummary = leakResult.leaks.map(function (l) { return l.type; }).join(', ');
    console.warn('[SelfPR] Skipping: leak detected in diff (' + leakSummary + ')');
    return { attempted: false, reason: 'leak_detected', leaks: leakResult.leaks.length };
  }

  const repo = SELF_PR_REPO;
  const capsuleIdShort = capsule && capsule.id ? String(capsule.id).slice(0, 8) : crypto.randomBytes(4).toString('hex');
  const branch = 'evolver-bot/mutation-' + capsuleIdShort;
  const title = buildPRTitle(mutation);
  const body = buildPRBody({ capsule, mutation, gene, blastRadius });

  try {
    console.log('[SelfPR] Creating PR on ' + repo + ' branch ' + branch + '...');

    const forkCheck = runGh('repo view ' + repo + ' --json name', { timeoutMs: 15000 });
    if (!forkCheck.ok) {
      console.warn('[SelfPR] Cannot access repo ' + repo + ': ' + (forkCheck.err || 'unknown'));
      return { attempted: false, reason: 'repo_access_failed' };
    }

    const tmpDir = path.join(getEvolutionDir(), 'self_pr_workdir');
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    const cloneResult = runGh(
      'repo clone ' + repo + ' "' + tmpDir + '" -- --depth 1',
      { timeoutMs: 60000 }
    );
    if (!cloneResult.ok) {
      console.warn('[SelfPR] Clone failed: ' + (cloneResult.err || 'unknown'));
      return { attempted: false, reason: 'clone_failed' };
    }

    try {
      execSync('git checkout -b "' + branch + '"', { cwd: tmpDir, timeout: 10000, maxBuffer: MAX_EXEC_BUFFER });
    } catch (e) {
      console.warn('[SelfPR] Branch creation failed: ' + (e.message || e));
      return { attempted: false, reason: 'branch_failed' };
    }

    for (const relFile of changedFiles) {
      const srcFile = path.join(repoRoot, relFile);
      const destFile = path.join(tmpDir, relFile);
      const destDir = path.dirname(destFile);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, destFile);
      }
    }

    try {
      execSync('git add -A', { cwd: tmpDir, timeout: 10000, maxBuffer: MAX_EXEC_BUFFER });
      const statusOut = execSync('git status --porcelain', { cwd: tmpDir, timeout: 10000, encoding: 'utf8', maxBuffer: MAX_EXEC_BUFFER });
      if (!statusOut || !statusOut.trim()) {
        console.log('[SelfPR] No changes to commit in public repo clone.');
        return { attempted: false, reason: 'no_public_diff' };
      }
      execSync(
        'git commit -m "' + title.replace(/"/g, '\\"') + '"',
        { cwd: tmpDir, timeout: 10000, env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'evolver-bot', GIT_AUTHOR_EMAIL: 'evolver-bot@evomap.ai', GIT_COMMITTER_NAME: 'evolver-bot', GIT_COMMITTER_EMAIL: 'evolver-bot@evomap.ai' }) }
      );
    } catch (e) {
      console.warn('[SelfPR] Commit failed: ' + (e.message || e));
      return { attempted: false, reason: 'commit_failed' };
    }

    try {
      execSync('git push origin "' + branch + '"', { cwd: tmpDir, timeout: 30000 });
    } catch (e) {
      console.warn('[SelfPR] Push failed: ' + (e.message || e));
      return { attempted: false, reason: 'push_failed' };
    }

    const bodyFile = path.join(tmpDir, '.pr_body.md');
    fs.writeFileSync(bodyFile, body);

    const prResult = runGh(
      'pr create --repo ' + repo +
      ' --head "' + branch + '"' +
      ' --title "' + title.replace(/"/g, '\\"') + '"' +
      ' --body-file "' + bodyFile + '"' +
      ' --label "auto-mutation"',
      { cwd: tmpDir, timeoutMs: 30000 }
    );

    if (fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    if (!prResult.ok) {
      console.warn('[SelfPR] PR creation failed: ' + (prResult.err || 'unknown'));
      return { attempted: true, reason: 'pr_create_failed', error: prResult.err };
    }

    const prUrl = prResult.out || '';
    console.log('[SelfPR] PR created: ' + prUrl);
    recordPR(diffHash);
    return { attempted: true, ok: true, pr_url: prUrl, branch: branch, diff_hash: diffHash };
  } catch (e) {
    console.warn('[SelfPR] Unexpected error (non-fatal): ' + (e && e.message ? e.message : e));
    return { attempted: false, reason: 'unexpected_error', error: String(e && e.message || e).slice(0, 200) };
  }
}

module.exports = {
  maybeCreatePR,
  isPublicNonObfuscated,
  isInCooldown,
  isDuplicateDiff,
  computeDiffHash,
  buildPRTitle,
  buildPRBody,
  readState,
  writeState,
  recordPR,
  // For testing
  _OBFUSCATED_FILES: OBFUSCATED_FILES,
};

const path = require('path');
const fs = require('fs');

let _cachedRepoRoot = null;

function getRepoRoot() {
  if (_cachedRepoRoot) return _cachedRepoRoot;

  if (process.env.EVOLVER_REPO_ROOT) {
    _cachedRepoRoot = process.env.EVOLVER_REPO_ROOT;
    return _cachedRepoRoot;
  }

  const ownDir = path.resolve(__dirname, '..', '..');

  if (fs.existsSync(path.join(ownDir, '.git'))) {
    _cachedRepoRoot = ownDir;
    return _cachedRepoRoot;
  }

  let dir = path.dirname(ownDir);
  while (dir !== '/' && dir !== '.') {
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (process.env.EVOLVER_USE_PARENT_GIT === 'true') {
        console.warn('[evolver] Using parent git repository at:', dir);
        _cachedRepoRoot = dir;
        return _cachedRepoRoot;
      }
      console.warn(
        '[evolver] Detected .git in parent directory', dir,
        '-- ignoring. Set EVOLVER_USE_PARENT_GIT=true to override,',
        'or EVOLVER_REPO_ROOT to specify the target directory explicitly.'
      );
      _cachedRepoRoot = ownDir;
      return _cachedRepoRoot;
    }
    dir = path.dirname(dir);
  }

  _cachedRepoRoot = ownDir;
  return _cachedRepoRoot;
}

function getWorkspaceRoot() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  const repoRoot = getRepoRoot();
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) {
    return workspaceDir;
  }

  return repoRoot;
}

function getLogsDir() {
  return process.env.EVOLVER_LOGS_DIR || path.join(getWorkspaceRoot(), 'logs');
}

function getEvolverLogPath() {
  return path.join(getLogsDir(), 'evolver_loop.log');
}

function getMemoryDir() {
  return process.env.MEMORY_DIR || path.join(getWorkspaceRoot(), 'memory');
}

function getSessionScope() {
  const raw = String(process.env.EVOLVER_SESSION_SCOPE || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 128);
  if (!safe || /^\.{1,2}$/.test(safe) || /\.\./.test(safe)) return null;
  return safe;
}

function getEvolutionDir() {
  const baseDir = process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  const baseDir = process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getSkillsDir() {
  return process.env.SKILLS_DIR || path.join(getWorkspaceRoot(), 'skills');
}

// Resolve the OpenClaw `sessions` directory for the agent that actually
// matches the current EVOLVER_SESSION_SCOPE (fixes #371).
//
// Precedence:
//   1. AGENT_SESSIONS_DIR         explicit override
//   2. EVOLVER_SESSION_SCOPE with a `workspace-<agent>` prefix =>
//      ~/.openclaw/agents/<agent>/sessions
//   3. AGENT_NAME (defaults to "main")   pre-#371 behavior
function getAgentSessionsDir() {
  if (process.env.AGENT_SESSIONS_DIR) return process.env.AGENT_SESSIONS_DIR;

  const scope = getSessionScope();
  let agentName = null;
  if (scope) {
    const match = /^workspace-(.+)$/.exec(scope);
    if (match) agentName = match[1];
  }
  if (!agentName) agentName = process.env.AGENT_NAME || 'main';

  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.openclaw', 'agents', agentName, 'sessions');
}

// Read the first `maxBytes` of a session .jsonl file and extract the `cwd`
// field from its header record (fixes #371, bug 2).
//
// OpenClaw session files are newline-delimited JSON. The first record is a
// session header that carries workspace context including `cwd`. The
// pre-#371 matcher tailed the file, which never saw the header. This
// reader is O(1) on file size. Returns null on any read/parse failure.
function readSessionCwdFromHead(sessionFilePath, maxBytes) {
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 800;
  try {
    if (!fs.existsSync(sessionFilePath)) return null;
    const fd = fs.openSync(sessionFilePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(cap, stat.size);
      if (readSize <= 0) return null;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      const newline = buf.indexOf('\n');
      const slice = newline >= 0 ? buf.slice(0, newline) : buf;
      const record = JSON.parse(slice.toString('utf8'));
      if (record && typeof record.cwd === 'string') return record.cwd;
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    return null;
  }
}

function getNarrativePath() {
  return path.join(getEvolutionDir(), 'evolution_narrative.md');
}

function getEvolutionPrinciplesPath() {
  const repoRoot = getRepoRoot();
  const custom = path.join(repoRoot, 'EVOLUTION_PRINCIPLES.md');
  if (fs.existsSync(custom)) return custom;
  return path.join(repoRoot, 'assets', 'gep', 'EVOLUTION_PRINCIPLES.md');
}

function getReflectionLogPath() {
  return path.join(getEvolutionDir(), 'reflection_log.jsonl');
}

module.exports = {
  getRepoRoot,
  getWorkspaceRoot,
  getLogsDir,
  getEvolverLogPath,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getSessionScope,
  getAgentSessionsDir,
  readSessionCwdFromHead,
  getNarrativePath,
  getEvolutionPrinciplesPath,
  getReflectionLogPath,
};

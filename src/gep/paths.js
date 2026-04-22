const path = require('path');
const fs = require('fs');

let _cachedRepoRoot = null;

// Resolve the git repository that evolver should treat as its work area.
//
// Precedence:
//   1. EVOLVER_REPO_ROOT (explicit override, always wins)
//   2. Nearest ancestor of process.cwd() that has a .git
//      (user ran evolver from inside their project)
//   3. Nearest ancestor of evolver's own directory that has a .git
//      (local npm install: evolver is inside the project's node_modules)
//   4. evolver's own directory if it has a .git (dev mode fallback)
//   5. Fall back to evolver's own directory.
//
//   CWD is checked first because the user's intent is almost always to
//   evolve the project they're standing in, not evolver itself.  evolver
//   self-evolution happens naturally when CWD *is* the evolver repo.
//
//   To opt out, set EVOLVER_NO_PARENT_GIT=true.  The older
//   EVOLVER_USE_PARENT_GIT=true flag is still honored for forward
//   compatibility but is no longer required.
function getRepoRoot() {
  if (_cachedRepoRoot) return _cachedRepoRoot;

  if (process.env.EVOLVER_REPO_ROOT) {
    _cachedRepoRoot = process.env.EVOLVER_REPO_ROOT;
    return _cachedRepoRoot;
  }

  const ownDir = path.resolve(__dirname, '..', '..');

  const noParent = String(process.env.EVOLVER_NO_PARENT_GIT || '').toLowerCase() === 'true';
  // Older flag kept for backward compatibility. Setting it to 'false'
  // explicitly is treated as an opt-out, mirroring EVOLVER_NO_PARENT_GIT.
  const legacyFlag = process.env.EVOLVER_USE_PARENT_GIT;
  const legacyOptOut = typeof legacyFlag === 'string' && legacyFlag.toLowerCase() === 'false';

  // Walk upward from process.cwd() — the project the user is standing in.
  if (!noParent && !legacyOptOut) {
    let cwd = process.cwd();
    while (cwd !== path.dirname(cwd)) {
      if (fs.existsSync(path.join(cwd, '.git'))) {
        if (!process.env.EVOLVER_QUIET_PARENT_GIT) {
          console.log('[evolver] Using host git repository at:', cwd);
        }
        _cachedRepoRoot = cwd;
        return _cachedRepoRoot;
      }
      cwd = path.dirname(cwd);
    }
  }

  // Walk upward from ownDir's parent (local install inside node_modules).
  if (!noParent && !legacyOptOut) {
    let dir = path.dirname(ownDir);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (!process.env.EVOLVER_QUIET_PARENT_GIT) {
          console.log('[evolver] Using host git repository at:', dir);
        }
        _cachedRepoRoot = dir;
        return _cachedRepoRoot;
      }
      dir = path.dirname(dir);
    }
  }

  // Fallback: evolver's own directory (dev mode or isolated install).
  if (fs.existsSync(path.join(ownDir, '.git'))) {
    _cachedRepoRoot = ownDir;
    return _cachedRepoRoot;
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
// field from its header record (fixes #371, bug 2). The pre-fix matcher
// tailed the file, so it never saw the header. This helper is O(1) on file
// size. Returns null on any read/parse failure.
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

const path = require('path');

function getRepoRoot() {
  // src/gep/paths.js -> repo root
  return path.resolve(__dirname, '..', '..');
}

function getWorkspaceRoot() {
  // skills/evolver -> workspace root
  return path.resolve(getRepoRoot(), '..', '..');
}

function getLogsDir() {
  return process.env.EVOLVER_LOGS_DIR || path.join(getWorkspaceRoot(), 'logs');
}

function getMemoryDir() {
  return process.env.MEMORY_DIR || path.join(getWorkspaceRoot(), 'memory');
}

// --- Session Scope Isolation ---
// When EVOLVER_SESSION_SCOPE is set (e.g., to a Discord channel ID or project name),
// evolution state, memory graph, and assets are isolated to a per-scope subdirectory.
// This prevents cross-channel/cross-project memory contamination.
// When NOT set, everything works as before (global scope, backward compatible).
function getSessionScope() {
  const raw = String(process.env.EVOLVER_SESSION_SCOPE || '').trim();
  if (!raw) return null;
  // Sanitize: only allow alphanumeric, dash, underscore, dot (prevent path traversal).
  const safe = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 128);
  return safe || null;
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

module.exports = {
  getRepoRoot,
  getWorkspaceRoot,
  getLogsDir,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getSessionScope,
};


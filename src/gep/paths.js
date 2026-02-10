const path = require('path');

function getRepoRoot() {
  // src/gep/paths.js -> repo root
  return path.resolve(__dirname, '..', '..');
}

function getMemoryDir() {
  const repoRoot = getRepoRoot();
  return process.env.MEMORY_DIR || path.join(repoRoot, 'memory');
}

function getEvolutionDir() {
  return process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  return process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
}

function getWorkspaceRoot() {
  // evolver repo root is skills/evolver/, workspace is two levels up
  return process.env.OPENCLAW_WORKSPACE || path.resolve(getRepoRoot(), '..', '..');
}

function getSkillsDir() {
  return path.join(getWorkspaceRoot(), 'skills');
}

function getLogsDir() {
  var dir = path.join(getWorkspaceRoot(), 'logs');
  var fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  getRepoRoot,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getWorkspaceRoot,
  getSkillsDir,
  getLogsDir,
};


const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

describe('getRepoRoot', () => {
  let tmpDir;
  const savedEnv = {};
  const envKeys = [
    'EVOLVER_REPO_ROOT', 'EVOLVER_USE_PARENT_GIT',
    'OPENCLAW_WORKSPACE', 'MEMORY_DIR', 'EVOLUTION_DIR', 'GEP_ASSETS_DIR',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns EVOLVER_REPO_ROOT when set', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const { getRepoRoot } = freshRequire('../src/gep/paths');
    assert.equal(getRepoRoot(), tmpDir);
  });

  it('returns own directory when it has .git', () => {
    const ownDir = path.resolve(__dirname, '..');
    const { getRepoRoot } = freshRequire('../src/gep/paths');
    delete process.env.EVOLVER_REPO_ROOT;
    const result = getRepoRoot();
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  it('EVOLVER_REPO_ROOT takes precedence over .git detection', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const { getRepoRoot } = freshRequire('../src/gep/paths');
    assert.equal(getRepoRoot(), tmpDir);
  });
});

describe('getSessionScope', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.EVOLVER_SESSION_SCOPE;
    delete process.env.EVOLVER_SESSION_SCOPE;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.EVOLVER_SESSION_SCOPE;
    else process.env.EVOLVER_SESSION_SCOPE = saved;
  });

  it('returns null when not set', () => {
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), null);
  });

  it('returns null for empty string', () => {
    process.env.EVOLVER_SESSION_SCOPE = '';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), null);
  });

  it('returns null for whitespace-only', () => {
    process.env.EVOLVER_SESSION_SCOPE = '   ';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), null);
  });

  it('returns sanitized value for valid scope', () => {
    process.env.EVOLVER_SESSION_SCOPE = 'channel-123';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), 'channel-123');
  });

  it('sanitizes special characters', () => {
    process.env.EVOLVER_SESSION_SCOPE = 'my/scope\\with:bad*chars';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    const result = getSessionScope();
    assert.ok(result);
    assert.ok(!/[\/\\:*]/.test(result), 'should not contain path-unsafe characters');
  });

  it('rejects path traversal attempts', () => {
    process.env.EVOLVER_SESSION_SCOPE = '..';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), null);
  });

  it('rejects embedded path traversal', () => {
    process.env.EVOLVER_SESSION_SCOPE = 'foo..bar';
    const { getSessionScope } = freshRequire('../src/gep/paths');
    assert.equal(getSessionScope(), null);
  });

  it('truncates to 128 characters', () => {
    process.env.EVOLVER_SESSION_SCOPE = 'a'.repeat(200);
    const { getSessionScope } = freshRequire('../src/gep/paths');
    const result = getSessionScope();
    assert.ok(result);
    assert.ok(result.length <= 128);
  });
});

describe('getEvolutionDir', () => {
  let saved = {};
  const envKeys = ['EVOLUTION_DIR', 'EVOLVER_SESSION_SCOPE', 'MEMORY_DIR', 'OPENCLAW_WORKSPACE', 'EVOLVER_REPO_ROOT'];

  beforeEach(() => {
    for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns EVOLUTION_DIR when set', () => {
    process.env.EVOLUTION_DIR = '/custom/evo';
    const { getEvolutionDir } = freshRequire('../src/gep/paths');
    assert.equal(getEvolutionDir(), '/custom/evo');
  });

  it('appends scope subdirectory when session scope is set', () => {
    process.env.EVOLUTION_DIR = '/custom/evo';
    process.env.EVOLVER_SESSION_SCOPE = 'test-scope';
    const { getEvolutionDir } = freshRequire('../src/gep/paths');
    const result = getEvolutionDir();
    assert.ok(result.includes('scopes'));
    assert.ok(result.includes('test-scope'));
  });

  it('returns base dir when no scope set', () => {
    process.env.EVOLUTION_DIR = '/custom/evo';
    const { getEvolutionDir } = freshRequire('../src/gep/paths');
    assert.equal(getEvolutionDir(), '/custom/evo');
    assert.ok(!getEvolutionDir().includes('scopes'));
  });
});

describe('getGepAssetsDir', () => {
  let saved = {};
  const envKeys = ['GEP_ASSETS_DIR', 'EVOLVER_SESSION_SCOPE', 'EVOLVER_REPO_ROOT'];

  beforeEach(() => {
    for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns GEP_ASSETS_DIR when set', () => {
    process.env.GEP_ASSETS_DIR = '/custom/assets';
    const { getGepAssetsDir } = freshRequire('../src/gep/paths');
    assert.equal(getGepAssetsDir(), '/custom/assets');
  });

  it('appends scope subdirectory when session scope is set', () => {
    process.env.GEP_ASSETS_DIR = '/custom/assets';
    process.env.EVOLVER_SESSION_SCOPE = 'my-project';
    const { getGepAssetsDir } = freshRequire('../src/gep/paths');
    const result = getGepAssetsDir();
    assert.ok(result.includes('scopes'));
    assert.ok(result.includes('my-project'));
  });
});

describe('getWorkspaceRoot', () => {
  let saved = {};
  let tmpDir;
  const envKeys = ['OPENCLAW_WORKSPACE', 'EVOLVER_REPO_ROOT'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns OPENCLAW_WORKSPACE when set', () => {
    process.env.OPENCLAW_WORKSPACE = '/my/workspace';
    const { getWorkspaceRoot } = freshRequire('../src/gep/paths');
    assert.equal(getWorkspaceRoot(), '/my/workspace');
  });

  it('returns a string when no env vars set', () => {
    const { getWorkspaceRoot } = freshRequire('../src/gep/paths');
    const result = getWorkspaceRoot();
    assert.ok(typeof result === 'string' && result.length > 0);
  });

  it('returns repoRoot when no workspace/ dir exists (standalone/Cursor fix)', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const { getWorkspaceRoot, getRepoRoot } = freshRequire('../src/gep/paths');
    assert.equal(getWorkspaceRoot(), getRepoRoot());
  });

  it('does NOT resolve to a directory above repoRoot', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const { getWorkspaceRoot } = freshRequire('../src/gep/paths');
    const wsRoot = getWorkspaceRoot();
    assert.ok(
      wsRoot.startsWith(tmpDir),
      'workspaceRoot should be at or below repoRoot, got: ' + wsRoot
    );
  });

  it('returns workspace/ subdirectory when it exists inside repoRoot', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir);
    const { getWorkspaceRoot } = freshRequire('../src/gep/paths');
    assert.equal(getWorkspaceRoot(), wsDir);
  });

  it('OPENCLAW_WORKSPACE takes precedence over workspace/ dir', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    process.env.OPENCLAW_WORKSPACE = '/override/path';
    fs.mkdirSync(path.join(tmpDir, 'workspace'));
    const { getWorkspaceRoot } = freshRequire('../src/gep/paths');
    assert.equal(getWorkspaceRoot(), '/override/path');
  });

  it('derived paths (memoryDir, logsDir, skillsDir) resolve under workspaceRoot', () => {
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    const { getWorkspaceRoot, getMemoryDir, getLogsDir, getSkillsDir } = freshRequire('../src/gep/paths');
    const ws = getWorkspaceRoot();
    assert.ok(getMemoryDir().startsWith(ws), 'memoryDir should be under workspaceRoot');
    assert.ok(getLogsDir().startsWith(ws), 'logsDir should be under workspaceRoot');
    assert.ok(getSkillsDir().startsWith(ws), 'skillsDir should be under workspaceRoot');
  });
});

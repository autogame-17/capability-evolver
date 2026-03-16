const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rejectPendingRun } = require('../index.js');

describe('loop-mode auto reject', () => {
  var tmpDir;
  var originalRepoRoot;
  var originalWorkspaceRoot;
  var originalEvDir;
  var originalMemoryDir;
  var originalA2aHubUrl;
  var originalHeartbeatMs;
  var originalWorkerEnabled;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-loop-test-'));
    originalRepoRoot = process.env.EVOLVER_REPO_ROOT;
    originalWorkspaceRoot = process.env.OPENCLAW_WORKSPACE;
    originalEvDir = process.env.EVOLUTION_DIR;
    originalMemoryDir = process.env.MEMORY_DIR;
    originalA2aHubUrl = process.env.A2A_HUB_URL;
    originalHeartbeatMs = process.env.HEARTBEAT_INTERVAL_MS;
    originalWorkerEnabled = process.env.WORKER_ENABLED;
    process.env.EVOLVER_REPO_ROOT = tmpDir;
    process.env.OPENCLAW_WORKSPACE = tmpDir;
    process.env.EVOLUTION_DIR = path.join(tmpDir, 'memory', 'evolution');
    process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
    process.env.A2A_HUB_URL = '';
    process.env.HEARTBEAT_INTERVAL_MS = '3600000';
    delete process.env.WORKER_ENABLED;
  });

  afterEach(() => {
    if (originalRepoRoot === undefined) delete process.env.EVOLVER_REPO_ROOT;
    else process.env.EVOLVER_REPO_ROOT = originalRepoRoot;
    if (originalWorkspaceRoot === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = originalWorkspaceRoot;
    if (originalEvDir === undefined) delete process.env.EVOLUTION_DIR;
    else process.env.EVOLUTION_DIR = originalEvDir;
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;
    if (originalA2aHubUrl === undefined) delete process.env.A2A_HUB_URL;
    else process.env.A2A_HUB_URL = originalA2aHubUrl;
    if (originalHeartbeatMs === undefined) delete process.env.HEARTBEAT_INTERVAL_MS;
    else process.env.HEARTBEAT_INTERVAL_MS = originalHeartbeatMs;
    if (originalWorkerEnabled === undefined) delete process.env.WORKER_ENABLED;
    else process.env.WORKER_ENABLED = originalWorkerEnabled;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks pending runs rejected without deleting untracked files', () => {
    const stateDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'evolution_solidify_state.json'), JSON.stringify({
      last_run: { run_id: 'run_123' }
    }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'PR_BODY.md'), 'keep me\n');
    const changed = rejectPendingRun(path.join(stateDir, 'evolution_solidify_state.json'));

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_solidify_state.json'), 'utf8'));
    assert.equal(changed, true);
    assert.equal(state.last_solidify.run_id, 'run_123');
    assert.equal(state.last_solidify.rejected, true);
    assert.equal(state.last_solidify.reason, 'loop_bridge_disabled_autoreject_no_rollback');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'PR_BODY.md'), 'utf8'), 'keep me\n');
  });
});

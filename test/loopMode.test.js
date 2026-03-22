const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rejectPendingRun, isPendingSolidify, readJsonSafe } = require('../index.js');

const savedEnv = {};
const envKeys = [
  'EVOLVER_REPO_ROOT', 'OPENCLAW_WORKSPACE', 'EVOLUTION_DIR',
  'MEMORY_DIR', 'A2A_HUB_URL', 'HEARTBEAT_INTERVAL_MS', 'WORKER_ENABLED',
];
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-loop-test-'));
  for (const k of envKeys) { savedEnv[k] = process.env[k]; }
  process.env.EVOLVER_REPO_ROOT = tmpDir;
  process.env.OPENCLAW_WORKSPACE = tmpDir;
  process.env.EVOLUTION_DIR = path.join(tmpDir, 'memory', 'evolution');
  process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
  process.env.A2A_HUB_URL = '';
  process.env.HEARTBEAT_INTERVAL_MS = '3600000';
  delete process.env.WORKER_ENABLED;
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loop-mode auto reject', () => {
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

describe('isPendingSolidify', () => {
  it('returns false when state is null', () => {
    assert.equal(isPendingSolidify(null), false);
  });

  it('returns false when state has no last_run', () => {
    assert.equal(isPendingSolidify({}), false);
  });

  it('returns false when last_run has no run_id', () => {
    assert.equal(isPendingSolidify({ last_run: {} }), false);
  });

  it('returns true when last_run has run_id but no last_solidify', () => {
    assert.equal(isPendingSolidify({ last_run: { run_id: 'run_1' } }), true);
  });

  it('returns true when last_solidify run_id differs from last_run', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 'run_2' },
      last_solidify: { run_id: 'run_1' },
    }), true);
  });

  it('returns false when last_solidify run_id matches last_run', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 'run_1' },
      last_solidify: { run_id: 'run_1' },
    }), false);
  });

  it('handles numeric run_ids via string coercion', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 123 },
      last_solidify: { run_id: '123' },
    }), false);
  });
});

describe('readJsonSafe', () => {
  it('returns null for non-existent file', () => {
    assert.equal(readJsonSafe(path.join(tmpDir, 'nonexistent.json')), null);
  });

  it('returns null for empty file', () => {
    const p = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(p, '');
    assert.equal(readJsonSafe(p), null);
  });

  it('returns null for whitespace-only file', () => {
    const p = path.join(tmpDir, 'whitespace.json');
    fs.writeFileSync(p, '   \n  ');
    assert.equal(readJsonSafe(p), null);
  });

  it('returns null for invalid JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ not valid json }');
    assert.equal(readJsonSafe(p), null);
  });

  it('parses valid JSON', () => {
    const p = path.join(tmpDir, 'good.json');
    fs.writeFileSync(p, JSON.stringify({ key: 'value' }));
    const result = readJsonSafe(p);
    assert.deepEqual(result, { key: 'value' });
  });
});

describe('bare invocation routing -- black-box', () => {
  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');

  it('node index.js (no args) starts evolution, not help', () => {
    const out = execFileSync(process.execPath, ['index.js'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, EVOLVE_BRIDGE: 'false', A2A_HUB_URL: '' },
    });
    assert.ok(out.includes('Starting evolver') || out.includes('GEP'),
      'bare invocation should start evolution, not show usage. Got: ' + out.slice(0, 200));
    assert.ok(!out.includes('Usage:'), 'should not show usage for bare invocation');
  });

  it('unknown command shows usage help', () => {
    const out = execFileSync(process.execPath, ['index.js', 'nonexistent-cmd'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, A2A_HUB_URL: '' },
    });
    assert.ok(out.includes('Usage:'), 'unknown command should show usage');
  });
});

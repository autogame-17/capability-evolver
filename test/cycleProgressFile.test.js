// Issue #19: progress file is the heartbeat the wrapper polls. It MUST
// be written atomically (tmp+rename) so a wrapper read never sees a
// half-written JSON, and tmp files MUST NOT accumulate on the disk.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeCycleProgressAtomic } = require('..');

describe('writeCycleProgressAtomic', () => {
  let tmpDir;
  let progressPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-progress-'));
    progressPath = path.join(tmpDir, 'cycle_progress.json');
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('writes a complete JSON file with all caller fields + updated_at', () => {
    const before = Date.now();
    const ok = writeCycleProgressAtomic(progressPath, {
      pid: 12345,
      outer_cycle: 5372,
      inner_cycle: 17,
      started_at: 1746543112000,
      phase: 'evolve.run',
    });
    const after = Date.now();
    assert.equal(ok, true);
    assert.equal(fs.existsSync(progressPath), true);

    const raw = fs.readFileSync(progressPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.pid, 12345);
    assert.equal(parsed.outer_cycle, 5372);
    assert.equal(parsed.inner_cycle, 17);
    assert.equal(parsed.started_at, 1746543112000);
    assert.equal(parsed.phase, 'evolve.run');
    assert.ok(typeof parsed.updated_at === 'number', 'updated_at must be a number');
    assert.ok(parsed.updated_at >= before && parsed.updated_at <= after,
      'updated_at must reflect call wall-clock');
  });

  it('overwrites previous contents on subsequent writes', () => {
    writeCycleProgressAtomic(progressPath, {
      pid: process.pid,
      outer_cycle: 1,
      inner_cycle: 1,
      started_at: 100,
      phase: 'sleep',
    });
    const parsed = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    assert.equal(parsed.phase, 'sleep');
    assert.equal(parsed.outer_cycle, 1);
  });

  it('does not leave .tmp files behind after a successful write', () => {
    writeCycleProgressAtomic(progressPath, {
      pid: process.pid,
      outer_cycle: 2,
      inner_cycle: 2,
      started_at: 200,
      phase: 'evolve.run',
    });
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, [], 'no .tmp.<pid> remnants allowed');
  });

  it('returns false on unwritable target without throwing', () => {
    const badPath = path.join(tmpDir, 'no-such-subdir', 'cycle_progress.json');
    const ok = writeCycleProgressAtomic(badPath, {
      pid: process.pid,
      outer_cycle: 1,
      inner_cycle: 1,
      started_at: 1,
      phase: 'evolve.run',
    });
    assert.equal(ok, false, 'should fail-soft (return false) on disk error');
    assert.equal(fs.existsSync(badPath), false);
  });
});

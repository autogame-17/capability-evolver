'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  determineIntensity,
  getScheduleRecommendation,
  readScheduleState,
  writeScheduleState,
  IDLE_THRESHOLD_SECONDS,
  DEEP_IDLE_THRESHOLD_SECONDS,
} = require('../src/gep/idleScheduler');

let tmpDir;
let savedEnv = {};

function setupTempEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-sched-test-'));
  savedEnv = {
    EVOLUTION_DIR: process.env.EVOLUTION_DIR,
    OMLS_ENABLED: process.env.OMLS_ENABLED,
  };
  process.env.EVOLUTION_DIR = path.join(tmpDir, 'evolution');
  fs.mkdirSync(process.env.EVOLUTION_DIR, { recursive: true });
}

function teardownTempEnv() {
  Object.keys(savedEnv).forEach(function (key) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

describe('determineIntensity', function () {
  it('returns normal for unknown idle (-1)', function () {
    assert.equal(determineIntensity(-1), 'normal');
  });

  it('returns normal for low idle', function () {
    assert.equal(determineIntensity(10), 'normal');
  });

  it('returns aggressive at threshold', function () {
    assert.equal(determineIntensity(IDLE_THRESHOLD_SECONDS), 'aggressive');
  });

  it('returns aggressive between thresholds', function () {
    assert.equal(determineIntensity(IDLE_THRESHOLD_SECONDS + 100), 'aggressive');
  });

  it('returns deep at deep threshold', function () {
    assert.equal(determineIntensity(DEEP_IDLE_THRESHOLD_SECONDS), 'deep');
  });

  it('returns deep above deep threshold', function () {
    assert.equal(determineIntensity(DEEP_IDLE_THRESHOLD_SECONDS + 1000), 'deep');
  });
});

describe('schedule state persistence', function () {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('writes and reads state correctly', function () {
    var state = { last_check: '2026-01-01T00:00:00Z', last_idle_seconds: 500, last_intensity: 'aggressive' };
    writeScheduleState(state);
    var loaded = readScheduleState();
    assert.equal(loaded.last_idle_seconds, 500);
    assert.equal(loaded.last_intensity, 'aggressive');
  });

  it('returns empty object when no state file', function () {
    var loaded = readScheduleState();
    assert.deepEqual(loaded, {});
  });
});

describe('getScheduleRecommendation', function () {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it('returns disabled result when OMLS_ENABLED=false', function () {
    process.env.OMLS_ENABLED = 'false';
    var rec = getScheduleRecommendation();
    assert.equal(rec.enabled, false);
    assert.equal(rec.sleep_multiplier, 1);
    delete process.env.OMLS_ENABLED;
  });

  it('returns enabled result with valid fields', function () {
    var rec = getScheduleRecommendation();
    assert.equal(rec.enabled, true);
    assert.equal(typeof rec.idle_seconds, 'number');
    assert.ok(['signal_only', 'normal', 'aggressive', 'deep'].includes(rec.intensity));
    assert.equal(typeof rec.sleep_multiplier, 'number');
    assert.ok(rec.sleep_multiplier > 0);
    assert.equal(typeof rec.should_distill, 'boolean');
    assert.equal(typeof rec.should_reflect, 'boolean');
    assert.equal(typeof rec.should_deep_evolve, 'boolean');
    assert.equal(typeof rec.should_explore, 'boolean');
  });

  it('should_explore=true implies aggressive or deep intensity', function () {
    // When should_explore is true (lines 128, 134 in idleScheduler.js), intensity
    // must be 'aggressive' or 'deep' - this is a consistency contract from the loop
    // runtime refactor (index.js line 281).
    var rec = getScheduleRecommendation();
    if (rec.should_explore === true) {
      assert.ok(
        rec.intensity === 'aggressive' || rec.intensity === 'deep',
        'should_explore=true but intensity=' + rec.intensity
      );
      // In aggressive/deep, distill and reflect are also enabled
      assert.equal(rec.should_distill, true, 'aggressive/deep must have should_distill=true');
      assert.equal(rec.should_reflect, true, 'aggressive/deep must have should_reflect=true');
    }
  });

  it('should_deep_evolve=true implies should_explore=true', function () {
    // Deep mode always includes explore (line 134 in idleScheduler.js)
    var rec = getScheduleRecommendation();
    if (rec.should_deep_evolve === true) {
      assert.equal(rec.should_explore, true, 'deep mode must have should_explore=true');
    }
  });

  it('OMLS_ENABLED=false forces all action flags to false', function () {
    process.env.OMLS_ENABLED = 'false';
    var rec = getScheduleRecommendation();
    assert.equal(rec.enabled, false);
    assert.equal(rec.should_distill, false);
    assert.equal(rec.should_reflect, false);
    assert.equal(rec.should_deep_evolve, false);
    assert.equal(rec.should_explore, false);
    delete process.env.OMLS_ENABLED;
  });
});

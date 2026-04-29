// test/featureFlags.test.js
// Tests for src/gep/featureFlags.js: persistent storage + read/write semantics,
// and the three-tier resolution in validator.isValidatorEnabled().
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequire(id) {
  delete require.cache[require.resolve(id)];
  return require(id);
}

describe('featureFlags persistence', function () {
  let tmpHome;
  let originalHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-flags-'));
    originalHome = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns undefined for unset key', function () {
    const ff = freshRequire('../src/gep/featureFlags');
    assert.equal(ff.readFeatureFlag('validator_enabled'), undefined);
  });

  it('persists value across cache resets', function () {
    process.env.EVOLVER_ENABLE_HUB_FEATURE_FLAGS = 'true';
    const ff = freshRequire('../src/gep/featureFlags');
    assert.equal(ff.writeFeatureFlag('validator_enabled', true, 'hub_mailbox'), true);

    const ff2 = freshRequire('../src/gep/featureFlags');
    assert.equal(ff2.readFeatureFlag('validator_enabled'), true);

    const all = ff2.getAllFeatureFlags();
    assert.equal(all.validator_enabled.value, true);
    assert.equal(all.validator_enabled.source, 'hub_mailbox');
    assert.ok(all.validator_enabled.updatedAt);
  });

  it('rejects empty / non-string keys', function () {
    const ff = freshRequire('../src/gep/featureFlags');
    assert.equal(ff.writeFeatureFlag('', true, 'src'), false);
    assert.equal(ff.writeFeatureFlag(null, true, 'src'), false);
    assert.equal(ff.readFeatureFlag(''), undefined);
  });
});

describe('isValidatorEnabled three-tier resolution', function () {
  let tmpHome;
  let originalHome;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-flags-'));
    originalHome = os.homedir;
    os.homedir = () => tmpHome;
    delete process.env.EVOLVER_VALIDATOR_ENABLED;
  });

  afterEach(() => {
    os.homedir = originalHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  it('defaults to true when env unset and no persisted flag', function () {
    freshRequire('../src/gep/featureFlags');
    const v = freshRequire('../src/gep/validator');
    assert.equal(v.isValidatorEnabled(), true);
  });

  it('env=0 wins over persisted flag=true', function () {
    process.env.EVOLVER_ENABLE_HUB_FEATURE_FLAGS = 'true';
    const ff = freshRequire('../src/gep/featureFlags');
    ff.writeFeatureFlag('validator_enabled', true, 'hub_mailbox');
    process.env.EVOLVER_VALIDATOR_ENABLED = '0';
    const v = freshRequire('../src/gep/validator');
    assert.equal(v.isValidatorEnabled(), false);
  });

  it('env=1 wins over persisted flag=false', function () {
    process.env.EVOLVER_ENABLE_HUB_FEATURE_FLAGS = 'true';
    const ff = freshRequire('../src/gep/featureFlags');
    ff.writeFeatureFlag('validator_enabled', false, 'hub_mailbox');
    process.env.EVOLVER_VALIDATOR_ENABLED = '1';
    const v = freshRequire('../src/gep/validator');
    assert.equal(v.isValidatorEnabled(), true);
  });

  it('persisted flag=false applied when env unset', function () {
    process.env.EVOLVER_ENABLE_HUB_FEATURE_FLAGS = 'true';
    const ff = freshRequire('../src/gep/featureFlags');
    ff.writeFeatureFlag('validator_enabled', false, 'hub_mailbox');
    const v = freshRequire('../src/gep/validator');
    assert.equal(v.isValidatorEnabled(), false);
  });

  it('rejects hub-sourced updates unless explicitly enabled', function () {
    const ff = freshRequire('../src/gep/featureFlags');
    assert.equal(ff.writeFeatureFlag('validator_enabled', false, 'hub_mailbox'), false);
    assert.equal(ff.readFeatureFlag('validator_enabled'), undefined);
  });

  it('rejects unknown keys and invalid value types', function () {
    const ff = freshRequire('../src/gep/featureFlags');
    assert.equal(ff.writeFeatureFlag('unexpected_flag', true, 'manual'), false);
    assert.equal(ff.writeFeatureFlag('validator_enabled', 'true', 'manual'), false);
  });

  it('accepts off/false/no aliases for env opt-out', function () {
    for (const val of ['off', 'false', 'no', 'OFF', 'False']) {
      process.env.EVOLVER_VALIDATOR_ENABLED = val;
      const v = freshRequire('../src/gep/validator');
      assert.equal(v.isValidatorEnabled(), false, 'value=' + val);
    }
  });
});

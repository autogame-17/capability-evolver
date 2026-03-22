const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const savedEnv = {};
const envKeys = ['EVOLVE_BRIDGE', 'OPENCLAW_WORKSPACE'];

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

beforeEach(() => {
  for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('determineBridgeEnabled -- white-box', () => {
  it('returns false when EVOLVE_BRIDGE unset and no OPENCLAW_WORKSPACE', () => {
    delete process.env.EVOLVE_BRIDGE;
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true when EVOLVE_BRIDGE unset but OPENCLAW_WORKSPACE is set', () => {
    delete process.env.EVOLVE_BRIDGE;
    process.env.OPENCLAW_WORKSPACE = '/some/workspace';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns true when EVOLVE_BRIDGE explicitly "true"', () => {
    process.env.EVOLVE_BRIDGE = 'true';
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false when EVOLVE_BRIDGE explicitly "false"', () => {
    process.env.EVOLVE_BRIDGE = 'false';
    process.env.OPENCLAW_WORKSPACE = '/some/workspace';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="True" (case insensitive)', () => {
    process.env.EVOLVE_BRIDGE = 'True';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false for EVOLVE_BRIDGE="False" (case insensitive)', () => {
    process.env.EVOLVE_BRIDGE = 'False';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="1" (truthy non-false string)', () => {
    process.env.EVOLVE_BRIDGE = '1';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false for EVOLVE_BRIDGE="" (empty string) without OPENCLAW_WORKSPACE', () => {
    process.env.EVOLVE_BRIDGE = '';
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="" (empty string) with OPENCLAW_WORKSPACE', () => {
    process.env.EVOLVE_BRIDGE = '';
    process.env.OPENCLAW_WORKSPACE = '/ws';
    const { determineBridgeEnabled } = freshRequire('../src/evolve');
    assert.equal(determineBridgeEnabled(), true);
  });
});

describe('determineBridgeEnabled -- black-box via child_process', () => {
  const { execFileSync } = require('child_process');

  function runBridgeCheck(env) {
    const script = `
      delete process.env.EVOLVE_BRIDGE;
      delete process.env.OPENCLAW_WORKSPACE;
      ${env.EVOLVE_BRIDGE !== undefined ? `process.env.EVOLVE_BRIDGE = ${JSON.stringify(env.EVOLVE_BRIDGE)};` : ''}
      ${env.OPENCLAW_WORKSPACE !== undefined ? `process.env.OPENCLAW_WORKSPACE = ${JSON.stringify(env.OPENCLAW_WORKSPACE)};` : ''}
      const { determineBridgeEnabled } = require('./src/evolve');
      console.log(determineBridgeEnabled());
    `;
    return execFileSync(process.execPath, ['-e', script], {
      cwd: require('path').resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, EVOLVE_BRIDGE: undefined, OPENCLAW_WORKSPACE: undefined },
    }).trim();
  }

  it('standalone mode: bridge off', () => {
    assert.equal(runBridgeCheck({}), 'false');
  });

  it('OpenClaw mode: bridge on', () => {
    assert.equal(runBridgeCheck({ OPENCLAW_WORKSPACE: '/ws' }), 'true');
  });

  it('explicit override: bridge forced on', () => {
    assert.equal(runBridgeCheck({ EVOLVE_BRIDGE: 'true' }), 'true');
  });

  it('explicit override: bridge forced off even with OPENCLAW_WORKSPACE', () => {
    assert.equal(runBridgeCheck({ EVOLVE_BRIDGE: 'false', OPENCLAW_WORKSPACE: '/ws' }), 'false');
  });
});

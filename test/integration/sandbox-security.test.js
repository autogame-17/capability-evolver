'use strict';
// Integration tests: sandboxExecutor security hardening
// Verifies that the shell:false fix (H1) and parseCommand (audit item) hold.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  parseCommand,
  ALLOWED_EXECUTABLES,
  runInSandbox,
} = require('../../src/gep/validator/sandboxExecutor');

describe('parseCommand — argv splitting', () => {
  it('splits plain command into executable + args', () => {
    const r = parseCommand('node scripts/validate-suite.js');
    assert.strictEqual(r.executable, 'node');
    assert.deepStrictEqual(r.args, ['scripts/validate-suite.js']);
  });

  it('handles double-quoted args with spaces', () => {
    const r = parseCommand('node -e "console.log(1)"');
    assert.strictEqual(r.executable, 'node');
    assert.ok(r.args.includes('console.log(1)'), 'quotes should be stripped');
  });

  it('handles single-quoted args', () => {
    const r = parseCommand("node -e 'process.exit(0)'");
    assert.strictEqual(r.executable, 'node');
    assert.ok(r.args.includes('process.exit(0)'));
  });

  it('accepts npx', () => {
    const r = parseCommand('npx mocha test.js');
    assert.strictEqual(r.executable, 'npx');
  });

  it('accepts npm', () => {
    const r = parseCommand('npm test');
    assert.strictEqual(r.executable, 'npm');
  });

  it('rejects unknown executable', () => {
    assert.throws(
      () => parseCommand('curl http://evil.com'),
      /not allowed/i,
    );
  });

  it('rejects bash', () => {
    assert.throws(
      () => parseCommand('bash -c "rm -rf /"'),
      /not allowed/i,
    );
  });

  it('rejects python', () => {
    assert.throws(
      () => parseCommand('python exploit.py'),
      /not allowed/i,
    );
  });

  it('rejects empty command', () => {
    assert.throws(() => parseCommand(''), /empty/i);
    assert.throws(() => parseCommand('   '), /empty/i);
  });

  it('normalises full path: /usr/bin/node is allowed', () => {
    const r = parseCommand('/usr/bin/node --version');
    assert.strictEqual(r.executable, '/usr/bin/node');
  });

  it('normalises .exe suffix on Windows-style path (no spaces)', () => {
    // Paths with spaces must be quoted by the caller; this tests unquoted paths.
    const r = parseCommand('C:\\nodejs\\node.exe --version');
    assert.ok(r.executable.includes('node'));
    assert.deepStrictEqual(r.args, ['--version']);
  });
});

describe('ALLOWED_EXECUTABLES set', () => {
  it('contains exactly node, npm, npx', () => {
    assert.ok(ALLOWED_EXECUTABLES.has('node'));
    assert.ok(ALLOWED_EXECUTABLES.has('npm'));
    assert.ok(ALLOWED_EXECUTABLES.has('npx'));
    assert.strictEqual(ALLOWED_EXECUTABLES.size, 3);
  });
});

describe('runInSandbox — shell injection guard', () => {
  it('returns spawn_failed for disallowed executable', async () => {
    const result = await runInSandbox(['curl http://example.com'], { cmdTimeoutMs: 5000 });
    assert.strictEqual(result.overallOk, false);
    const firstResult = result.results[0];
    assert.ok(firstResult, 'should have at least one result entry');
    assert.ok(!firstResult.ok);
    assert.ok(/spawn_failed|not allowed/i.test(firstResult.stderr));
  });

  it('executes a safe node command successfully', async () => {
    const result = await runInSandbox(['node -e "process.exit(0)"'], { cmdTimeoutMs: 10000 });
    assert.strictEqual(result.overallOk, true);
    assert.strictEqual(result.results[0].exitCode, 0);
  });

  it('stops at first failure (fail-fast)', async () => {
    const result = await runInSandbox([
      'node -e "process.exit(1)"',
      'node -e "process.exit(0)"',
    ], { cmdTimeoutMs: 10000 });
    assert.strictEqual(result.overallOk, false);
    assert.strictEqual(result.stoppedEarly, true);
    assert.strictEqual(result.results.length, 1, 'second command should not run');
  });

  it('enforces per-command timeout', async () => {
    const result = await runInSandbox(
      ['node -e "setTimeout(()=>{},9999)"'],
      { cmdTimeoutMs: 500, batchTimeoutMs: 2000 },
    );
    assert.strictEqual(result.results[0].timedOut, true);
    assert.strictEqual(result.overallOk, false);
  });

  it('sandbox dir is cleaned up after execution', async () => {
    const fs = require('fs');
    const result = await runInSandbox(['node -e "process.exit(0)"'], {
      cmdTimeoutMs: 5000,
      keepSandbox: false,
    });
    // sandboxDir is null when keepSandbox=false
    assert.strictEqual(result.sandboxDir, null);
  });
});

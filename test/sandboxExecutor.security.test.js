'use strict';

// Regression tests for the v1.69.8 security hardening of sandboxExecutor.
// See GH issue #451 (H1 — shell injection via spawn({shell:true})).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseCommand,
  assertNodeCommandSafe,
  assertScriptPathSafe,
  ALLOWED_EXECUTABLES,
  BLOCKED_NODE_FLAGS,
} = require('../src/gep/validator/sandboxExecutor');

test('parseCommand splits a simple command', () => {
  const r = parseCommand('node index.js');
  assert.strictEqual(r.executable, 'node');
  assert.deepStrictEqual(r.args, ['index.js']);
});

test('parseCommand handles quoted args with spaces', () => {
  const r = parseCommand('node "my script.js" --flag value');
  assert.strictEqual(r.executable, 'node');
  assert.deepStrictEqual(r.args, ['my script.js', '--flag', 'value']);
});

test('parseCommand rejects shell metacharacters', () => {
  for (const bad of [
    'node idx.js; rm -rf /',
    'node idx.js && echo pwn',
    'node idx.js | tee pwn.log',
    'node idx.js `cat /etc/passwd`',
    'node idx.js $(cat /etc/passwd)',
    'node idx.js > /tmp/x',
    'node idx.js < /tmp/x',
    'node idx.js & background',
  ]) {
    assert.throws(
      () => parseCommand(bad),
      /metacharacter|shell/i,
      'expected ' + bad + ' to be rejected',
    );
  }
});

test('parseCommand rejects empty and non-string input', () => {
  assert.throws(() => parseCommand(''));
  assert.throws(() => parseCommand(null));
  assert.throws(() => parseCommand(123));
});

test('ALLOWED_EXECUTABLES contains only node (GHSA-jxh8-jh77-xh6g: npm/npx removed)', () => {
  const allowed = Array.from(ALLOWED_EXECUTABLES).sort();
  assert.deepStrictEqual(allowed, ['node']);
});

test('ALLOWED_EXECUTABLES rejects npm and npx (lifecycle-script RCE class)', () => {
  // Both npm and npx execute arbitrary code by design (preinstall/install/
  // postinstall lifecycle scripts for npm; remote package bin entry for npx).
  // GHSA-jxh8-jh77-xh6g removes them from the allowlist so a compromised or
  // MitM'd Hub cannot ship `npm install <evil-tgz>` as a validation command.
  for (const binary of ['npm', 'npx']) {
    assert.strictEqual(
      ALLOWED_EXECUTABLES.has(binary),
      false,
      binary + ' must not be in the allowlist (GHSA-jxh8-jh77-xh6g)',
    );
  }
});

test('ALLOWED_EXECUTABLES rejects shell and arbitrary binaries', () => {
  for (const binary of ['bash', 'sh', 'zsh', 'cmd', 'python', 'curl', 'wget', 'rm']) {
    assert.strictEqual(
      ALLOWED_EXECUTABLES.has(binary),
      false,
      binary + ' must not be in the allowlist',
    );
  }
});

test('BLOCKED_NODE_FLAGS contains the eval/require class flags', () => {
  for (const flag of ['-e', '--eval', '-p', '--print', '-r', '--require', '--loader', '--import']) {
    assert.strictEqual(
      BLOCKED_NODE_FLAGS.has(flag),
      true,
      flag + ' must be in BLOCKED_NODE_FLAGS',
    );
  }
});

test('assertNodeCommandSafe rejects inline eval flags', () => {
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['-e', 'console.log(1)'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--eval=1+1'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['-p', '1+1'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--require', './preload.js', 'script.js'] }),
    /node flag not allowed/,
  );
});

test('assertNodeCommandSafe rejects node with no positional script', () => {
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: [] }),
    /script file argument/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--no-warnings'] }),
    /script file argument/,
  );
});

test('assertNodeCommandSafe is a no-op for non-node executables', () => {
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'npm', args: ['test'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'npx', args: ['-y', 'eslint', '.'] }));
});

test('assertNodeCommandSafe accepts well-formed node invocations', () => {
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['index.js'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['--no-warnings', 'index.js'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['scripts/validate-suite.js', '--quiet'] }));
});

test('assertScriptPathSafe rejects absolute and escaping paths', () => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-executor-test-'));
  try {
    const inSandbox = path.join(sandboxDir, 'ok.js');
    fs.writeFileSync(inSandbox, 'console.log("ok")\n', 'utf8');
    assert.doesNotThrow(() => assertScriptPathSafe({ executable: 'node', args: ['ok.js'] }, sandboxDir));

    const parentEscape = path.join('..', 'escape.js');
    assert.throws(
      () => assertScriptPathSafe({ executable: 'node', args: [parentEscape] }, sandboxDir),
      /escapes_sandbox/,
    );

    const absolute = path.resolve(sandboxDir, 'ok.js');
    assert.throws(
      () => assertScriptPathSafe({ executable: 'node', args: [absolute] }, sandboxDir),
      /absolute_script_path_not_allowed/,
    );
  } finally {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  }
});

test('assertScriptPathSafe rejects missing script files', () => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-executor-test-'));
  try {
    assert.throws(
      () => assertScriptPathSafe({ executable: 'node', args: ['missing.js'] }, sandboxDir),
      /script_not_found_in_sandbox/,
    );
  } finally {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  }
});

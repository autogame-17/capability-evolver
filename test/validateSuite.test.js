'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

test('validate-suite accepts a single test file argument', () => {
  const output = execFileSync(process.execPath, [
    'scripts/validate-suite.js',
    'test/mailboxStore.test.js',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.match(output, /ok: \d+ test\(s\) passed, 0 failed/);
});

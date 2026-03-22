const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'public.manifest.json');

describe('public build exclusion rules', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const excludePatterns = manifest.exclude || [];

  it('excludes test/vibe_test.js from public build', () => {
    assert.ok(excludePatterns.includes('test/vibe_test.js'),
      'vibe_test.js should be in exclude list');
  });

  it('excludes test/llm_helper.js from public build', () => {
    assert.ok(excludePatterns.includes('test/llm_helper.js'),
      'llm_helper.js should be in exclude list');
  });

  it('excludes test/fixtures/** from public build', () => {
    assert.ok(excludePatterns.includes('test/fixtures/**'),
      'test/fixtures should be in exclude list');
  });

  it('excludes memory/** from public build', () => {
    assert.ok(excludePatterns.includes('memory/**'),
      'memory dir should be in exclude list');
  });

  it('excludes this test file from public build', () => {
    assert.ok(excludePatterns.includes('test/build-exclude.test.js'),
      'build-exclude.test.js should be in exclude list (private-only test)');
  });

  it('includes test/*.test.js in public build', () => {
    const includes = manifest.include || [];
    const hasTestInclude = includes.some(p =>
      p === 'test/*.test.js' || p === 'test/**/*.test.js'
    );
    assert.ok(hasTestInclude, 'test/*.test.js should be in include list');
  });

  it('does not exclude core test files from public build', () => {
    const coreTests = [
      'test/paths.test.js',
      'test/signals.test.js',
      'test/bridge.test.js',
      'test/prompt.test.js',
      'test/loopMode.test.js',
      'test/selector.test.js',
    ];
    for (const t of coreTests) {
      assert.ok(!excludePatterns.includes(t),
        t + ' should NOT be in exclude list (it is a public test)');
    }
  });
});

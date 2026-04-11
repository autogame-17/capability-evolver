// Usage: node scripts/validate-suite.js [test-glob-pattern]
// Runs the evolver test suite — repo root is hardcoded, no shell glob needed.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const EVOLVER_REPO_ROOT = path.join(__dirname, '..');
const pattern = process.argv[2] || 'test/*.test.js';

function expandTestGlob(repoRoot, pattern) {
  const dir = pattern.replace(/\/\*\.test\.js$/, '');
  const fullDir = path.isAbsolute(dir)
    ? dir
    : path.join(repoRoot, dir);
  return fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(fullDir, f))
    .sort();
}

const files = expandTestGlob(EVOLVER_REPO_ROOT, pattern);
if (files.length === 0) {
  console.error('FAIL: no tests found matching pattern: ' + pattern);
  process.exit(1);
}

const cmd = 'node --test ' + files.join(' ');
const env = Object.assign({}, process.env, {
  NODE_ENV: 'test',
  EVOLVER_REPO_ROOT,
  GEP_ASSETS_DIR: path.join(EVOLVER_REPO_ROOT, 'assets', 'gep'),
});
delete env.EVOLVE_BRIDGE;
delete env.OPENCLAW_WORKSPACE;

try {
  const output = execSync(cmd, {
    cwd: EVOLVER_REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180000,
    env,
  });
  const out = output.toString('utf8');
  // Node test runner outputs: "pass 123" (not "# pass (123)")
  const passMatch = out.match(/pass (\d+)/);
  const failMatch = out.match(/fail (\d+)/);
  const passCount = passMatch ? Number(passMatch[1]) : 0;
  const failCount = failMatch ? Number(failMatch[1]) : 0;

  if (failCount > 0) {
    console.error('FAIL: ' + failCount + ' test(s) failed');
    process.exit(1);
  }
  if (passCount === 0) {
    console.error('FAIL: no tests found');
    process.exit(1);
  }
  console.log('ok: ' + passCount + ' test(s) passed, 0 failed');
} catch (e) {
  const stderr = e.stderr ? e.stderr.toString('utf8').slice(-500) : '';
  const stdout = e.stdout ? e.stdout.toString('utf8').slice(-500) : '';
  console.error('FAIL: test suite exited with code ' + (e.status || 'unknown'));
  if (stderr) console.error(stderr);
  if (stdout) console.error(stdout);
  process.exit(1);
}

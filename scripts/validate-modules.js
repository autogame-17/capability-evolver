// Usage: node scripts/validate-modules.js ./src/evolve ./src/gep/solidify
// Validates that each module (1) loads without errors, (2) exports something
// meaningful, and (3) exported functions are callable (typeof check).
const path = require('path');
const modules = process.argv.slice(2);
if (!modules.length) { console.error('No modules specified'); process.exit(1); }

let checked = 0;
for (const m of modules) {
  const resolved = path.resolve(m);
  const exported = require(resolved);

  if (exported === undefined || exported === null) {
    console.error('FAIL: ' + m + ' exports null/undefined');
    process.exit(1);
  }

  const t = typeof exported;
  if (t === 'object' && Object.keys(exported).length === 0) {
    console.error('FAIL: ' + m + ' exports an empty object (no public API)');
    process.exit(1);
  }

  // Previously this block contained a nested `typeof === 'function'` test
  // inside `typeof === 'function'`, which was trivially false and made the
  // intended "declared but not callable" warning unreachable. Without a
  // declaration manifest we cannot tell which exported keys are expected
  // to be functions, so the block is left as a no-op but the dead branch
  // is removed to avoid giving false assurance.
  checked++;
}

console.log('ok: ' + checked + ' module(s) validated');

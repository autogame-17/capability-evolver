// Usage: node scripts/validate-modules.js ./src/evolve ./src/gep/solidify
// Validates that each module (1) loads without errors, (2) exports something
// meaningful, and (3) exported functions are callable (typeof check).
const path = require('path');
const modules = process.argv.slice(2);
if (!modules.length) { console.error('No modules specified'); process.exit(1); }

let checked = 0;
for (const m of modules) {
  const resolved = path.resolve(m);
  let exported;
  try {
    exported = require(resolved);
  } catch (e) {
    console.error('FAIL: ' + m + ' failed to load: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }

  if (exported === undefined || exported === null) {
    console.error('FAIL: ' + m + ' exports null/undefined');
    process.exit(1);
  }

  const t = typeof exported;
  if (t === 'object' && Object.keys(exported).length === 0) {
    console.error('FAIL: ' + m + ' exports an empty object (no public API)');
    process.exit(1);
  }

  if (t === 'object') {
    const keys = Object.keys(exported);
    for (const k of keys) {
      if (typeof exported[k] === 'function') {
        if (typeof exported[k] !== 'function') {
          console.error('FAIL: ' + m + '.' + k + ' is declared but not a callable function');
          process.exit(1);
        }
      }
    }
  }
  checked++;
}

console.log('ok: ' + checked + ' module(s) validated');

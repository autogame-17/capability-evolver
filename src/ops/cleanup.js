// GEP Artifact Cleanup - Evolver Core Module
// Removes old gep_prompt_*.json/txt files from evolution dir.
// Keeps at least 10 most recent files regardless of age.

const fs = require('fs');
const path = require('path');
const { getEvolutionDir } = require('../gep/paths');

var MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
var MIN_KEEP = 10;

function run() {
    var evoDir = getEvolutionDir();
    if (!fs.existsSync(evoDir)) return;

    var files = fs.readdirSync(evoDir)
        .filter(function(f) { return /^gep_prompt_.*\.(json|txt)$/.test(f); })
        .map(function(f) {
            var full = path.join(evoDir, f);
            var stat = fs.statSync(full);
            return { name: f, path: full, mtime: stat.mtimeMs };
        })
        .sort(function(a, b) { return b.mtime - a.mtime; }); // newest first

    var now = Date.now();
    var deleted = 0;

    for (var i = MIN_KEEP; i < files.length; i++) {
        if (now - files[i].mtime > MAX_AGE_MS) {
            try {
                fs.unlinkSync(files[i].path);
                deleted++;
            } catch (e) {}
        }
    }

    if (deleted > 0) {
        console.log('[Cleanup] Deleted ' + deleted + ' old GEP artifacts.');
    }
    return deleted;
}

if (require.main === module) {
    console.log('[Cleanup] Scanning for old artifacts...');
    var count = run();
    console.log('[Cleanup] ' + (count > 0 ? 'Deleted ' + count + ' files.' : 'No files to delete.'));
}

module.exports = { run };

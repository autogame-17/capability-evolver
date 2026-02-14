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

    // Phase 1: Age-based cleanup (keep at least MIN_KEEP)
    // [OPTIMIZATION] Batch deletion for age-based cleanup as well
    const filesToDelete = [];
    for (var i = MIN_KEEP; i < files.length; i++) {
        if (now - files[i].mtime > MAX_AGE_MS) {
            filesToDelete.push(files[i].path);
        }
    }
    
    if (filesToDelete.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < filesToDelete.length; i += BATCH_SIZE) {
            const batch = filesToDelete.slice(i, i + BATCH_SIZE);
            try {
                // Remove package-lock.json if it exists (not relevant here but good practice in other contexts)
                // Use rm -f with quotes to handle paths safely
                // Phase 1 optimization update: mirroring phase 2 logic
                const args = batch.map(function(p) { return '"' + p + '"'; }).join(' ');
                require('child_process').execSync('rm -f ' + args, { stdio: 'ignore' });
                deleted += batch.length;
            } catch (e) {
                // Fallback to serial deletion if batch fails
                batch.forEach(function(p) {
                    try { fs.unlinkSync(p); deleted++; } catch (_) {}
                });
            }
        }
    }

    // Phase 2: Size-based safety cap (keep max 10 files total to drastically reduce bloat)
    // Re-scan remaining files after age cleanup
    try {
        var remainingFiles = fs.readdirSync(evoDir)
            .filter(function(f) { return /^gep_prompt_.*\.(json|txt)$/.test(f); })
            .map(function(f) {
                var full = path.join(evoDir, f);
                var stat = fs.statSync(full);
                return { name: f, path: full, mtime: stat.mtimeMs };
            })
            .sort(function(a, b) { return b.mtime - a.mtime; }); // newest first

        // [OPTIMIZATION] Batch deletion using execSync('rm') for speed and robustness
        var MAX_FILES = 10;
        if (remainingFiles.length > MAX_FILES) {
            const toDelete = remainingFiles.slice(MAX_FILES).map(function(f) { return f.path; });
            
            // Chunking into batches of 50 to avoid E2BIG on some systems, 
            // though with MAX_FILES=10 and typical usage, list won't be huge.
            const BATCH_SIZE = 50;
            for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
                const batch = toDelete.slice(i, i + BATCH_SIZE);
                try {
                    // Safe bulk delete via shell, faster than serial unlinkSync
                    // Using "rm -f" to ignore non-existent files
                    const args = batch.map(function(p) { return '"' + p + '"'; }).join(' ');
                    require('child_process').execSync('rm -f ' + args, { stdio: 'ignore' });
                    deleted += batch.length;
                } catch (e) {
                    // Fallback to serial if batch fails
                    batch.forEach(function(p) {
                        try { fs.unlinkSync(p); deleted++; } catch (_) {}
                    });
                }
            }
        }
    } catch (e) {
        console.warn('[Cleanup] Phase 2 failed:', e.message);
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

// Git Self-Repair - Evolver Core Module
// Emergency repair for git sync failures: abort rebase/merge, remove stale locks.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getWorkspaceRoot } = require('../gep/paths');

var LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function repair(gitRoot) {
    var root = gitRoot || getWorkspaceRoot();
    var repaired = [];

    // 1. Abort pending rebase
    try {
        execSync('git rebase --abort', { cwd: root, stdio: 'ignore' });
        repaired.push('rebase_aborted');
        console.log('[SelfRepair] Aborted pending rebase.');
    } catch (e) {}

    // 2. Abort pending merge
    try {
        execSync('git merge --abort', { cwd: root, stdio: 'ignore' });
        repaired.push('merge_aborted');
        console.log('[SelfRepair] Aborted pending merge.');
    } catch (e) {}

    // 3. Remove stale index.lock
    var lockFile = path.join(root, '.git', 'index.lock');
    if (fs.existsSync(lockFile)) {
        try {
            var stat = fs.statSync(lockFile);
            var age = Date.now() - stat.mtimeMs;
            if (age > LOCK_MAX_AGE_MS) {
                fs.unlinkSync(lockFile);
                repaired.push('stale_lock_removed');
                console.log('[SelfRepair] Removed stale index.lock (' + Math.round(age / 60000) + 'min old).');
            }
        } catch (e) {}
    }

    // 4. Fetch origin (safe, read-only)
    try {
        execSync('git fetch origin', { cwd: root, stdio: 'ignore', timeout: 30000 });
        repaired.push('fetch_ok');
    } catch (e) {
        console.warn('[SelfRepair] git fetch failed: ' + e.message);
    }

    return repaired;
}

if (require.main === module) {
    var result = repair();
    console.log('[SelfRepair] Result:', result.length > 0 ? result.join(', ') : 'nothing to repair');
}

module.exports = { repair };

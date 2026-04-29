// Git Self-Repair - Evolver Core Module
// Emergency repair for git sync failures: abort rebase/merge, remove stale locks.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// 10 MB — prevents RangeError on large child process output (e.g. git log/diff
// on large repos). See GHSA reports / issue #451.
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

const { getWorkspaceRoot } = require('../gep/paths');

var LOCK_MAX_AGE_MS = require('../config').LOCK_MAX_AGE_MS;

function runGit(args, options) {
    return execFileSync('git', Array.isArray(args) ? args : [], Object.assign({
        encoding: 'utf8',
        stdio: 'ignore',
        maxBuffer: MAX_EXEC_BUFFER,
        windowsHide: true,
    }, options || {}));
}

function repair(gitRoot) {
    var root = gitRoot || getWorkspaceRoot();
    var repaired = [];

    // 1. Abort pending rebase
    try {
        runGit(['rebase', '--abort'], { cwd: root });
        repaired.push('rebase_aborted');
        console.log('[SelfRepair] Aborted pending rebase.');
    } catch (e) {}

    // 2. Abort pending merge
    try {
        runGit(['merge', '--abort'], { cwd: root });
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

    // 4. Reset to remote main if local is corrupt (last resort - guarded by flag)
    // Only enabled if explicitly called with --force-reset or EVOLVE_GIT_RESET=true
    if (process.env.EVOLVE_GIT_RESET === 'true') {
        try {
            console.warn('[SelfRepair] EVOLVE_GIT_RESET=true set. Resetting local branch to origin/main (HARD reset).');
            runGit(['fetch', 'origin', 'main'], { cwd: root });
            runGit(['reset', '--hard', 'origin/main'], { cwd: root });
            repaired.push('hard_reset_to_origin');
        } catch (e) {
            console.warn('[SelfRepair] Hard reset failed: ' + e.message);
        }
    } else {
        // Safe fetch
        try {
            runGit(['fetch', 'origin'], { cwd: root, timeout: 30000 });
            repaired.push('fetch_ok');
        } catch (e) {
            console.warn('[SelfRepair] git fetch failed: ' + e.message);
        }
    }

    return repaired;
}

if (require.main === module) {
    var result = repair();
    console.log('[SelfRepair] Result:', result.length > 0 ? result.join(', ') : 'nothing to repair');
}

module.exports = { repair };

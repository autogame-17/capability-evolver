const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultMount() {
    if (process.platform === 'win32') {
        return path.parse(process.cwd()).root || 'C:\\';
    }
    return '/';
}

function getDiskUsage(mount) {
    try {
        const targetMount = mount || getDefaultMount();
        // Use Node 18+ statfs if available
        if (fs.statfsSync) {
            const stats = fs.statfsSync(targetMount);
            const total = stats.blocks * stats.bsize;
            const free = stats.bavail * stats.bsize; // available to unprivileged users
            const used = total - free;
            return {
                pct: Math.round((used / total) * 100),
                freeMb: Math.round(free / 1024 / 1024)
            };
        }
        return { pct: -1, freeMb: -1, error: 'statfs unavailable on this Node runtime' };
    } catch (e) {
        return { pct: -1, freeMb: -1, error: e.message };
    }
}

function runHealthCheck() {
    const checks = [];
    let criticalErrors = 0;
    let warnings = 0;

    // 1. Secret Check (Critical for external services, but maybe not for the agent itself to run)
    const criticalSecrets = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
    criticalSecrets.forEach(key => {
        if (!process.env[key] || process.env[key].trim() === '') {
            checks.push({ name: `env:${key}`, ok: false, status: 'missing', severity: 'warning' }); // Downgraded to warning to prevent restart loops
            warnings++;
        } else {
            checks.push({ name: `env:${key}`, ok: true, status: 'present' });
        }
    });

    const optionalSecrets = ['OPENAI_API_KEY'];
    optionalSecrets.forEach(key => {
        if (!process.env[key] || process.env[key].trim() === '') {
            checks.push({ name: `env:${key}`, ok: false, status: 'missing', severity: 'info' });
        } else {
            checks.push({ name: `env:${key}`, ok: true, status: 'present' });
        }
    });

    // 2. Disk Space Check
    const disk = getDiskUsage(getDefaultMount());
    if (disk.error) {
        checks.push({ name: 'disk_space', ok: false, status: 'check failed: ' + disk.error, severity: 'warning' });
        warnings++;
    } else if (disk.pct > 90) {
        checks.push({ name: 'disk_space', ok: false, status: `${disk.pct}% used`, severity: 'critical' });
        criticalErrors++;
    } else if (disk.pct > 80) {
        checks.push({ name: 'disk_space', ok: false, status: `${disk.pct}% used`, severity: 'warning' });
        warnings++;
    } else {
        checks.push({ name: 'disk_space', ok: true, status: `${disk.pct}% used` });
    }

    // 3. Memory Check
    const memFree = os.freemem();
    const memTotal = os.totalmem();
    const memPct = Math.round(((memTotal - memFree) / memTotal) * 100);
    if (memPct > 95) {
        checks.push({ name: 'memory', ok: false, status: `${memPct}% used`, severity: 'critical' });
        criticalErrors++;
    } else {
        checks.push({ name: 'memory', ok: true, status: `${memPct}% used` });
    }

    // 4. Process Count (Check for fork bombs or leaks)
    // Only on Linux. Cached for 60s since readdirSync('/proc') is heavy.
    if (process.platform === 'linux') {
        try {
            const now = Date.now();
            if (!runHealthCheck._procCache || now - runHealthCheck._procCacheAt > 60000) {
                runHealthCheck._procCache = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f)).length;
                runHealthCheck._procCacheAt = now;
            }
            const pidCount = runHealthCheck._procCache;
            if (pidCount > 2000) {
                 checks.push({ name: 'process_count', ok: false, status: `${pidCount} procs`, severity: 'warning' });
                 warnings++;
            } else {
                 checks.push({ name: 'process_count', ok: true, status: `${pidCount} procs` });
            }
        } catch(e) { /* /proc read non-critical on non-Linux */ }
    }

    // Determine Overall Status
    let status = 'ok';
    if (criticalErrors > 0) status = 'error';
    else if (warnings > 0) status = 'warning';

    return {
        status,
        timestamp: new Date().toISOString(),
        checks
    };
}

module.exports = { runHealthCheck };

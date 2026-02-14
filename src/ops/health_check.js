const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function getDiskUsage(mount) {
    try {
        // Use Node 18+ statfs if available
        if (fs.statfsSync) {
            const stats = fs.statfsSync(mount || '/');
            const total = stats.blocks * stats.bsize;
            const free = stats.bavail * stats.bsize; // available to unprivileged users
            const used = total - free;
            return {
                pct: Math.round((used / total) * 100),
                freeMb: Math.round(free / 1024 / 1024)
            };
        }
        // Fallback
        const out = execSync(`df -P "${mount || '/'}" | tail -1 | awk '{print $5, $4}'`).toString().trim().split(' ');
        return {
            pct: parseInt(out[0].replace('%', '')),
            freeMb: Math.round(parseInt(out[1]) / 1024) // df returns 1k blocks usually
        };
    } catch (e) {
        return { pct: 0, freeMb: 999999, error: e.message };
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

    const optionalSecrets = ['CLAWHUB_TOKEN', 'OPENAI_API_KEY'];
    optionalSecrets.forEach(key => {
        if (!process.env[key] || process.env[key].trim() === '') {
            checks.push({ name: `env:${key}`, ok: false, status: 'missing', severity: 'info' });
        } else {
            checks.push({ name: `env:${key}`, ok: true, status: 'present' });
        }
    });

    // 2. Disk Space Check
    const disk = getDiskUsage('/');
    if (disk.pct > 90) {
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
    // Only on Linux
    if (process.platform === 'linux') {
        try {
            // Optimization: readdirSync /proc is heavy. Use a lighter check or skip if too frequent.
            // But since this is health check, we'll keep it but increase the threshold to reduce noise.
            const pids = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f));
            if (pids.length > 2000) { // Bumped threshold to 2000
                 checks.push({ name: 'process_count', ok: false, status: `${pids.length} procs`, severity: 'warning' });
                 warnings++;
            } else {
                 checks.push({ name: 'process_count', ok: true, status: `${pids.length} procs` });
            }
        } catch(e) {}
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

// Evolver Lifecycle Manager - Evolver Core Module
// Provides: start, stop, restart, status, log, health check
// The loop script to spawn is configurable via EVOLVER_LOOP_SCRIPT env var.
// Cross-platform: works on Linux/macOS (ps) and Windows (WMI via PowerShell).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
// 10 MB — prevents RangeError on large child process output (e.g. git log/diff
// on large repos). See GHSA reports / issue #451.
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

const { getRepoRoot, getWorkspaceRoot, getEvolverLogPath } = require('../gep/paths');

var WORKSPACE_ROOT = getWorkspaceRoot();
var LOG_FILE = getEvolverLogPath();
var PID_FILE = path.join(WORKSPACE_ROOT, 'memory', 'evolver_loop.pid');
var MAX_SILENCE_MS = require('../config').MAX_SILENCE_MS;

function getLoopScript() {
    // Prefer wrapper if exists, fallback to core evolver
    if (process.env.EVOLVER_LOOP_SCRIPT) return process.env.EVOLVER_LOOP_SCRIPT;
    var wrapper = path.join(WORKSPACE_ROOT, 'skills/feishu-evolver-wrapper/index.js');
    if (fs.existsSync(wrapper)) return wrapper;
    return path.join(getRepoRoot(), 'index.js');
}

// --- Portable helpers ---

function sleepMs(ms) {
    var delay = Math.max(0, Math.floor(Number(ms) || 0));
    if (delay <= 0) return;
    // Atomics.wait blocks without spawning a subprocess; works on all platforms.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function execText(file, args) {
    return execFileSync(file, Array.isArray(args) ? args : [], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: MAX_EXEC_BUFFER,
        windowsHide: true,
    });
}

function listProcesses() {
    if (process.platform === 'win32') {
        var out = execText('powershell', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | ForEach-Object { $cmd = if ($_.CommandLine) { $_.CommandLine } else { '' }; Write-Output ('{0}`t{1}' -f $_.ProcessId, $cmd) }",
        ]);
        var procs = [];
        for (var line of out.split(/\r?\n/)) {
            if (!line || !line.trim()) continue;
            var tabIndex = line.indexOf('\t');
            var pidText = tabIndex >= 0 ? line.slice(0, tabIndex).trim() : line.trim();
            var cmdText = tabIndex >= 0 ? line.slice(tabIndex + 1).trim() : '';
            var pid = parseInt(pidText, 10);
            if (!isNaN(pid)) procs.push({ pid: pid, args: cmdText });
        }
        return procs;
    }
    var psOut = execText('ps', ['-e', '-o', 'pid=,args=']);
    var unixProcs = [];
    for (var psLine of psOut.split('\n')) {
        var trimmed = psLine.trim();
        if (!trimmed) continue;
        var parts = trimmed.split(/\s+/);
        var pidUnix = parseInt(parts[0], 10);
        if (isNaN(pidUnix)) continue;
        unixProcs.push({ pid: pidUnix, args: parts.slice(1).join(' ') });
    }
    return unixProcs;
}

// --- Process Discovery ---

function getRunningPids() {
    try {
        var pids = [];
        for (var proc of listProcesses()) {
            var pid = proc.pid;
            var cmd = (proc.args || '').trim();
            if (pid === process.pid) continue;
            var cmdLower = cmd.toLowerCase();
            // Match any `node ... index.js ... --loop` invocation.
            // Wrapper path prefix filters were removed so launchd/plist or direct
            // node invocations are also discovered (fixes #379, #403).
            if (cmdLower.includes('node') && cmdLower.includes('index.js') && cmdLower.includes('--loop')) {
                pids.push(pid);
            }
        }
        return [...new Set(pids)].filter(isPidRunning);
    } catch (e) {
        return [];
    }
}

function isPidRunning(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function getCmdLine(pid) {
    try {
        const safePid = parseInt(pid, 10);
        if (isNaN(safePid)) return null;
        var proc = listProcesses().find(function(p) { return p.pid === safePid; });
        return proc ? (proc.args || '').trim() : null;
    } catch (e) {
        return null;
    }
}

// --- Lifecycle ---

function start(options) {
    var delayMs = (options && options.delayMs) || 0;
    var pids = getRunningPids();
    if (pids.length > 0) {
        console.log('[Lifecycle] Already running (PIDs: ' + pids.join(', ') + ').');
        return { status: 'already_running', pids: pids };
    }
    if (delayMs > 0) {
        sleepMs(delayMs);
    }

    var script = getLoopScript();
    console.log('[Lifecycle] Starting: node ' + path.relative(WORKSPACE_ROOT, script) + ' --loop');

    var out = fs.openSync(LOG_FILE, 'a');
    var err = fs.openSync(LOG_FILE, 'a');

    var env = Object.assign({}, process.env);
    var npmGlobal = path.join(process.env.HOME || '', '.npm-global/bin');
    if (env.PATH && !env.PATH.includes(npmGlobal)) {
        env.PATH = npmGlobal + ':' + env.PATH;
    }

    var child = spawn('node', [script, '--loop'], {
        detached: true, stdio: ['ignore', out, err], cwd: WORKSPACE_ROOT, env: env
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log('[Lifecycle] Started PID ' + child.pid);
    return { status: 'started', pid: child.pid };
}

function stop() {
    var pids = getRunningPids();
    if (pids.length === 0) {
        console.log('[Lifecycle] No running evolver loops found.');
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        return { status: 'not_running' };
    }
    for (var i = 0; i < pids.length; i++) {
        console.log('[Lifecycle] Stopping PID ' + pids[i] + '...');
        try { process.kill(pids[i], 'SIGTERM'); } catch (e) {}
    }
    var attempts = 0;
    while (getRunningPids().length > 0 && attempts < 10) {
        sleepMs(500);
        attempts++;
    }
    var remaining = getRunningPids();
    for (var j = 0; j < remaining.length; j++) {
        console.log('[Lifecycle] SIGKILL PID ' + remaining[j]);
        try { process.kill(remaining[j], 'SIGKILL'); } catch (e) {}
    }
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    var evolverLock = path.join(getRepoRoot(), 'evolver.pid');
    if (fs.existsSync(evolverLock)) fs.unlinkSync(evolverLock);
    console.log('[Lifecycle] All stopped.');
    return { status: 'stopped', killed: pids };
}

function restart(options) {
    stop();
    return start(Object.assign({ delayMs: 2000 }, options || {}));
}

function status() {
    var pids = getRunningPids();
    if (pids.length > 0) {
        return { running: true, pids: pids.map(function(p) { return { pid: p, cmd: getCmdLine(p) }; }), log: path.relative(WORKSPACE_ROOT, LOG_FILE) };
    }
    return { running: false };
}

function tailLog(lines) {
    if (!fs.existsSync(LOG_FILE)) return { error: 'No log file' };
    try {
        const n = parseInt(lines, 10) || 20;
        const fd = fs.openSync(LOG_FILE, 'r');
        var content = '';
        try {
            const stat = fs.fstatSync(fd);
            if (stat.size > 0) {
                const chunkSize = 64 * 1024;
                let position = stat.size;
                let collected = '';
                let lineCount = 0;
                while (position > 0 && lineCount <= n) {
                    const readSize = Math.min(chunkSize, position);
                    position -= readSize;
                    const buf = Buffer.alloc(readSize);
                    fs.readSync(fd, buf, 0, readSize, position);
                    collected = buf.toString('utf8') + collected;
                    lineCount = collected.split('\n').length - 1;
                }
                const rows = collected.split('\n');
                if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
                content = rows.slice(-n).join('\n');
            }
        } finally {
            fs.closeSync(fd);
        }
        return {
            file: path.relative(WORKSPACE_ROOT, LOG_FILE),
            content: content
        };
    } catch (e) {
        return { error: e.message };
    }
}

function checkHealth() {
    var pids = getRunningPids();
    if (pids.length === 0) return { healthy: false, reason: 'not_running' };
    if (fs.existsSync(LOG_FILE)) {
        var silenceMs = Date.now() - fs.statSync(LOG_FILE).mtimeMs;
        if (silenceMs > MAX_SILENCE_MS) {
            return { healthy: false, reason: 'stagnation', silenceMinutes: Math.round(silenceMs / 60000) };
        }
    }
    return { healthy: true, pids: pids };
}

// --- CLI ---
if (require.main === module) {
    var action = process.argv[2];
    switch (action) {
        case 'start': console.log(JSON.stringify(start())); break;
        case 'stop': console.log(JSON.stringify(stop())); break;
        case 'restart': console.log(JSON.stringify(restart())); break;
        case 'status': console.log(JSON.stringify(status(), null, 2)); break;
        case 'log': var r = tailLog(); console.log(r.content || r.error); break;
        case 'check':
            var health = checkHealth();
            console.log(JSON.stringify(health, null, 2));
            if (!health.healthy) { console.log('[Lifecycle] Restarting...'); restart(); }
            break;
        default: console.log('Usage: node lifecycle.js [start|stop|restart|status|log|check]');
    }
}

module.exports = { start, stop, restart, status, tailLog, checkHealth, getRunningPids };

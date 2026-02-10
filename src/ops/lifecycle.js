// Evolver Lifecycle Manager - Evolver Core Module
// Provides: start, stop, restart, status, log, health check
// The loop script to spawn is configurable via EVOLVER_LOOP_SCRIPT env var.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { getRepoRoot, getWorkspaceRoot, getLogsDir } = require('../gep/paths');

var WORKSPACE_ROOT = getWorkspaceRoot();
var LOG_FILE = path.join(getLogsDir(), 'evolver_loop.log');
var PID_FILE = path.join(WORKSPACE_ROOT, 'memory', 'evolver_loop.pid');
var MAX_SILENCE_MS = 30 * 60 * 1000;

function getLoopScript() {
    // Prefer wrapper if exists, fallback to core evolver
    if (process.env.EVOLVER_LOOP_SCRIPT) return process.env.EVOLVER_LOOP_SCRIPT;
    var wrapper = path.join(WORKSPACE_ROOT, 'skills/feishu-evolver-wrapper/index.js');
    if (fs.existsSync(wrapper)) return wrapper;
    return path.join(getRepoRoot(), 'index.js');
}

// --- Process Discovery ---

function getRunningPids() {
    try {
        var out = execSync('ps -e -o pid,args', { encoding: 'utf8' });
        var pids = [];
        for (var line of out.split('\n')) {
            var trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('PID')) continue;
            var parts = trimmed.split(/\s+/);
            var pid = parseInt(parts[0], 10);
            var cmd = parts.slice(1).join(' ');
            if (pid === process.pid) continue;
            if (cmd.includes('node') && cmd.includes('index.js') && cmd.includes('--loop')) {
                if (cmd.includes('feishu-evolver-wrapper') || cmd.includes('skills/evolver')) {
                    pids.push(pid);
                }
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
    try { return execSync('ps -p ' + pid + ' -o args=', { encoding: 'utf8' }).trim(); } catch (e) { return null; }
}

// --- Lifecycle ---

function start(options) {
    var delayMs = (options && options.delayMs) || 0;
    var pids = getRunningPids();
    if (pids.length > 0) {
        console.log('[Lifecycle] Already running (PIDs: ' + pids.join(', ') + ').');
        return { status: 'already_running', pids: pids };
    }
    if (delayMs > 0) execSync('sleep ' + (delayMs / 1000));

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
        execSync('sleep 0.5');
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
        return { file: path.relative(WORKSPACE_ROOT, LOG_FILE), content: execSync('tail -n ' + (lines || 20) + ' "' + LOG_FILE + '"', { encoding: 'utf8' }) };
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

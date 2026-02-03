#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { program } = require('commander');
const { execSync } = require('child_process');
const { sendCard } = require('../feishu-card/send.js');

program
  .option('-s, --status <text>', 'Status text/markdown content')
  .option('-f, --file <path>', 'Path to markdown file content')
  .option('-c, --cycle <id>', 'Evolution Cycle ID')
  .option('--title <text>', 'Card Title override')
  .option('--target <id>', 'Target User/Chat ID')
  .parse(process.argv);

const options = program.opts();

const STATE_FILE = path.resolve(__dirname, '../../memory/evolution_state.json');

function getCycleInfo() {
    let nextId = 1;
    let durationStr = 'N/A';
    const now = new Date();

    // 1. Try State File (Fast & Persistent)
    try {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (state.lastCycleId) {
                nextId = state.lastCycleId + 1;
                
                // Calculate duration since last cycle
                if (state.lastUpdate) {
                    const diff = now.getTime() - new Date(state.lastUpdate).getTime();
                    const mins = Math.floor(diff / 60000);
                    const secs = Math.floor((diff % 60000) / 1000);
                    durationStr = `${mins}m ${secs}s`;
                }

                // Auto-increment and save
                state.lastCycleId = nextId;
                state.lastUpdate = now.toISOString();
                fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
                return { id: nextId, duration: durationStr };
            }
        }
    } catch (e) {}

    // 2. Fallback: MEMORY.md (Legacy/Seed)
    let maxId = 0;
    try {
        const memPath = path.resolve(__dirname, '../../MEMORY.md');
        if (fs.existsSync(memPath)) {
            const memContent = fs.readFileSync(memPath, 'utf8');
            const matches = [...memContent.matchAll(/Cycle #(\d+)/g)];
            for (const match of matches) {
                const id = parseInt(match[1]);
                if (id > maxId) maxId = id;
            }
        }
    } catch (e) {}

    // Initialize State File if missing
    nextId = (maxId > 0 ? maxId : Math.floor(Date.now() / 1000)) + 1;
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            lastCycleId: nextId,
            lastUpdate: now.toISOString()
        }, null, 2));
    } catch(e) {}

    return { id: nextId, duration: 'First Run' };
}

// Resolve content
let content = options.status || '';
if (options.file) {
    try {
        content = fs.readFileSync(options.file, 'utf8');
    } catch (e) {
        console.error(`Failed to read file: ${options.file}`);
        process.exit(1);
    }
}

if (!content) {
    console.error('Error: Must provide --status or --file');
    process.exit(1);
}

// Prepare Title
const cycleInfo = options.cycle ? { id: options.cycle, duration: 'Manual' } : getCycleInfo();
const cycleId = cycleInfo.id;
const title = options.title || `🧬 Evolution #${cycleId} Log`;

// Resolve Target
const MASTER_ID = process.env.OPENCLAW_MASTER_ID || 'ou_cdc63fe05e88c580aedead04d851fc04'; // Fallback to Master ID from USER.md
const target = options.target || MASTER_ID;

// Execute direct integration
(async () => {
    if (!target) {
        console.error('[Wrapper] Error: No target ID found (Env OPENCLAW_MASTER_ID missing and no --target).');
        process.exit(1);
    }

    try {
        console.log(`[Wrapper] Reporting Cycle #${cycleId} to ${target}...`);
        
        // Direct call to feishu-card logic
        // Bypasses shell escaping issues and temporary files
        
        // Monitor Process Count (Leak Detection)
        const procCount = (() => { try { return execSync('ps -e | wc -l', { timeout: 1000 }).toString().trim(); } catch(e) { return '?'; } })();
        
        // System Health
        const memUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const uptime = Math.round(process.uptime());
        
        // Load Average
        const loadAvg = os.loadavg()[0].toFixed(2);
        
        // Disk Usage (Root)
        let diskUsage = '?';
        try {
            const df = execSync('df -h / | tail -1 | awk \'{print $5}\'', { timeout: 1000 }).toString().trim();
            diskUsage = df;
        } catch (e) {}

        // --- ERROR LOG CHECK ---
        let errorAlert = '';
        try {
            // Dynamic Evolver Path Resolution
            const evolverDirName = ['private-evolver', 'evolver', 'capability-evolver'].find(d => fs.existsSync(path.resolve(__dirname, `../${d}/index.js`))) || 'private-evolver';
            const evolverDir = path.resolve(__dirname, `../${evolverDirName}`);
            const errorLogPath = path.join(evolverDir, 'evolution_error.log');

            if (fs.existsSync(errorLogPath)) {
                const stats = fs.statSync(errorLogPath);
                const now = new Date();
                const diffMs = now - stats.mtime;
                
                // If error log was touched in the last 10 minutes, report it
                if (diffMs < 10 * 60 * 1000) {
                    // Optimized: Use tail to read only the last line, avoiding memory spike on large logs
                    const lastLine = execSync(`tail -n 1 "${errorLogPath}"`, { timeout: 1000, encoding: 'utf8' }).trim().substring(0, 200);
                    errorAlert = `\n\n⚠️ **CRITICAL ALERT**: System reported a failure ${(diffMs/1000/60).toFixed(1)}m ago.\n> ${lastLine}`;
                }
            }
        } catch (e) {
            // Ignore error checking failures
        }

        const finalContent = `${content}${errorAlert}\n\n*(Process Count: ${procCount} | Memory: ${memUsage}MB | Uptime: ${uptime}s | Load: ${loadAvg} | Disk: ${diskUsage} | Cycle Duration: ${cycleInfo.duration})*`;


        await sendCard({
            target: target,
            title: title,
            text: finalContent,
            color: 'blue'
        });
        
        console.log('[Wrapper] Report sent successfully.');
    } catch (e) {
        console.error('[Wrapper] Report failed:', e.message);
        process.exit(1);
    }
})();

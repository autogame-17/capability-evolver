const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Load environment variables from workspace root
try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch (e) {
    // dotenv might not be installed or .env missing, proceed gracefully
}

// Default Configuration
const MEMORY_DIR = process.env.MEMORY_DIR || path.resolve(__dirname, '../../memory');
const AGENT_NAME = process.env.AGENT_NAME || 'main';
const AGENT_SESSIONS_DIR = path.join(os.homedir(), `.openclaw/agents/${AGENT_NAME}/sessions`);
const TODAY_LOG = path.join(MEMORY_DIR, new Date().toISOString().split('T')[0] + '.md');

function formatSessionLog(jsonlContent) {
    const result = [];
    const lines = jsonlContent.split('\n');
    
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const data = JSON.parse(line);
            if (data.type === 'message' && data.message) {
                const role = (data.message.role || 'unknown').toUpperCase();
                let content = '';
                if (Array.isArray(data.message.content)) {
                        content = data.message.content.map(c => {
                            if(c.type === 'text') return c.text;
                            if(c.type === 'toolCall') return `[TOOL: ${c.name}]`;
                            return '';
                        }).join(' ');
                } else if (typeof data.message.content === 'string') {
                    content = data.message.content;
                } else {
                    content = JSON.stringify(data.message.content);
                }
                
                // Filter: Skip Heartbeats to save noise
                if (content.trim() === 'HEARTBEAT_OK') continue;
                if (content.includes('NO_REPLY')) continue;

                // Clean up newlines for compact reading
                content = content.replace(/\n+/g, ' ').slice(0, 300);
                result.push(`**${role}**: ${content}`);
            } else if (data.type === 'tool_result' || (data.message && data.message.role === 'toolResult')) {
                    // Filter: Skip generic success results or short uninformative ones
                    // Only show error or significant output
                    let resContent = '';
                    if (data.tool_result && data.tool_result.output) resContent = data.tool_result.output;
                    if (data.content) resContent = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
                    
                    if (resContent.length < 50 && (resContent.includes('success') || resContent.includes('done'))) continue;
                    if (resContent.trim() === '') continue;
                    
                    // Improvement: Show snippet of result (especially errors) instead of hiding it
                    const preview = resContent.replace(/\n+/g, ' ').slice(0, 200);
                    result.push(`[TOOL RESULT] ${preview}${resContent.length > 200 ? '...' : ''}`);
            }
        } catch (e) { continue; }
    }
    return result.join('\n');
}

function readRealSessionLog() {
    try {
        if (!fs.existsSync(AGENT_SESSIONS_DIR)) return '[NO SESSION LOGS FOUND]';
        
        let files = [];
        
        // Strategy: Node.js native sort (Faster than execSync for <100 files)
        // Note: performMaintenance() ensures file count stays low (~100 max)
        files = fs.readdirSync(AGENT_SESSIONS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
                try {
                    return { name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() };
                } catch (e) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.time - a.time); // Newest first

        if (files.length === 0) return '[NO JSONL FILES]';

        let content = '';
        const TARGET_BYTES = 64000; // Increased context (was 24000) for smarter evolution
        
        // Read the latest file first (efficient tail read)
        const latestFile = path.join(AGENT_SESSIONS_DIR, files[0].name);
        content = readRecentLog(latestFile, TARGET_BYTES);
        
        // If content is short (e.g. just started a session), peek at the previous one too
        if (content.length < TARGET_BYTES && files.length > 1) {
            const prevFile = path.join(AGENT_SESSIONS_DIR, files[1].name);
            const needed = TARGET_BYTES - content.length;
            const prevContent = readRecentLog(prevFile, needed);
            
            // Format to show continuity
            content = `\n--- PREVIOUS SESSION (${files[1].name}) ---\n${formatSessionLog(prevContent)}\n\n--- CURRENT SESSION (${files[0].name}) ---\n${formatSessionLog(content)}`;
        } else {
             content = formatSessionLog(content);
        }
        
        return content;
    } catch (e) {
        return `[ERROR READING SESSION LOGS: ${e.message}]`;
    }
}

function readRecentLog(filePath, size = 10000) {
    try {
        if (!fs.existsSync(filePath)) return `[MISSING] ${filePath}`;
        const stats = fs.statSync(filePath);
        const start = Math.max(0, stats.size - size);
        const buffer = Buffer.alloc(stats.size - start);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        return buffer.toString('utf8');
    } catch (e) {
        return `[ERROR READING ${filePath}: ${e.message}]`;
    }
}

function checkSystemHealth() {
    let report = [];
    try {
        // Uptime & Node Version
        const uptime = (os.uptime() / 3600).toFixed(1);
        report.push(`Uptime: ${uptime}h`);
        report.push(`Node: ${process.version}`);

        // Memory Usage (RSS)
        const mem = process.memoryUsage();
        const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
        report.push(`Agent RSS: ${rssMb}MB`);

        // Optimization: Use native Node.js fs.statfsSync instead of spawning 'df'
        if (fs.statfsSync) {
            const stats = fs.statfsSync('/');
            const total = stats.blocks * stats.bsize;
            const free = stats.bfree * stats.bsize;
            const used = total - free;
            const freeGb = (free / 1024 / 1024 / 1024).toFixed(1);
            const usedPercent = Math.round((used / total) * 100);
            report.push(`Disk: ${usedPercent}% (${freeGb}G free)`);
        } else {
            // Fallback for older Node versions
            const df = execSync('df -h /', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
            const lines = df.trim().split('\n');
            if (lines.length > 1) {
                // parsing: Filesystem Size Used Avail Use% Mounted on
                const parts = lines[1].split(/\s+/);
                report.push(`Disk: ${parts[4]} (${parts[3]} free)`);
            }
        }
    } catch (e) {}

    try {
        // Process count: Attempt pgrep first (faster), fallback to ps
        try {
            const pgrep = execSync('pgrep -c node', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
            report.push(`Node Processes: ${pgrep.trim()}`);
        } catch (e) {
            // Fallback to ps if pgrep fails/missing
            const ps = execSync('ps aux | grep node | grep -v grep | wc -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
            report.push(`Node Processes: ${ps.trim()}`);
        }
    } catch (e) {}

    // Integration Health Checks (Env Vars & Tokens)
    try {
        const issues = [];
        if (!process.env.GEMINI_API_KEY) issues.push('Gemini Key Missing');
        if (!process.env.FEISHU_APP_ID) issues.push('Feishu App ID Missing');
        // Check Feishu Token Freshness
        try {
            const tokenPath = path.resolve(MEMORY_DIR, 'feishu_token.json');
            if (fs.existsSync(tokenPath)) {
                const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
                if (tokenData.expire < Date.now() / 1000) issues.push('Feishu Token Expired');
            } else {
                issues.push('Feishu Token Missing');
            }
        } catch(e) {}

        if (issues.length > 0) {
            report.push(`⚠️ Integrations: ${issues.join(', ')}`);
        } else {
            report.push(`✅ Integrations: Nominal`);
        }
    } catch (e) {}
    
    return report.length ? report.join(' | ') : 'Health Check Unavailable';
}

function getMutationDirective(logContent) {
    // 🧬 FORCE MUTATION MODE (Override by Master Directive: 2026-02-02)
    // Stability scans are disallowed. Every cycle must evolve.
    
    // Adaptive Logic: Still check errors to decide TYPE of mutation
    // Optimization: Regex now catches more error variants (Error:, Exception:, FAIL)
    const errorMatches = logContent.match(/\[ERROR|Error:|Exception:|FAIL|Failed|"isError":true/gi) || [];
    const errorCount = errorMatches.length;
    const isUnstable = errorCount > 2;

    const roll = Math.floor(Math.random() * 100) + 1;
    
    // If unstable, force stability unless roll is critical (95+)
    if (isUnstable && roll < 95) {
         return `
**🧬 ADAPTIVE REPAIR MODE (Detected ${errorCount} recent errors)**
The system detected instability. You MUST perform a **Repair Mutation**.
**MANDATORY DIRECTIVE**:
- **Fix Bugs**: Locate the source of the recent errors and patch them.
- **Harden Code**: Add try/catch blocks or input validation.
- **Do NOT** just scan. You must write code to fix the problem.
`;
    }

    // Default: Aggressive Evolution
    return `
**🧬 FORCED MUTATION MODE (Master Directive)**
Stability scans are BANNED. You MUST evolve the system.
**Directives:**
- **Optimize**: Find a script that is slow or verbose and streamline it.
- **Harden**: Add error handling to a fragile function.
- **Automate**: Identify a manual task the user does often and script it.
- **Analyze**: Dig deeper into logs to find hidden inefficiencies.
*Goal: Code Singularity. Every cycle adds value.*
`;
}

const STATE_FILE = path.join(MEMORY_DIR, 'evolution_state.json');
// Fix: Look for MEMORY.md in root first, then memory dir to support both layouts
const ROOT_MEMORY = path.resolve(__dirname, '../../MEMORY.md');
const DIR_MEMORY = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_FILE = fs.existsSync(ROOT_MEMORY) ? ROOT_MEMORY : DIR_MEMORY;
const USER_FILE = path.resolve(__dirname, '../../USER.md');

function readMemorySnippet() {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return '[MEMORY.md MISSING]';
        const content = fs.readFileSync(MEMORY_FILE, 'utf8');
        // Optimization: Increased limit from 2000 to 50000 for modern context windows
        return content.length > 50000 ? content.slice(0, 50000) + `\n... [TRUNCATED: ${content.length - 50000} chars remaining]` : content;
    } catch (e) {
        return '[ERROR READING MEMORY.md]';
    }
}

function readUserSnippet() {
    try {
        if (!fs.existsSync(USER_FILE)) return '[USER.md MISSING]';
        return fs.readFileSync(USER_FILE, 'utf8');
    } catch (e) {
        return '[ERROR READING USER.md]';
    }
}

function getNextCycleId() {
    let state = { cycleCount: 0, lastRun: 0 };
    try {
        if (fs.existsSync(STATE_FILE)) {
            state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) {}
    
    state.cycleCount = (state.cycleCount || 0) + 1;
    state.lastRun = Date.now();
    
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
    
    return String(state.cycleCount).padStart(4, '0');
}

function performMaintenance() {
    try {
        if (!fs.existsSync(AGENT_SESSIONS_DIR)) return;
        
        // Count files
        const files = fs.readdirSync(AGENT_SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        if (files.length < 100) return; // Limit before cleanup

        console.log(`[Maintenance] Found ${files.length} session logs. Archiving old ones...`);
        
        const ARCHIVE_DIR = path.join(AGENT_SESSIONS_DIR, 'archive');
        if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

        // Sort by time (oldest first)
        const fileStats = files.map(f => {
            try {
                return { name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() };
            } catch(e) { return null; }
        }).filter(Boolean).sort((a, b) => a.time - b.time);

        // Keep last 50 files, archive the rest
        const toArchive = fileStats.slice(0, fileStats.length - 50);
        
        for (const file of toArchive) {
            const oldPath = path.join(AGENT_SESSIONS_DIR, file.name);
            const newPath = path.join(ARCHIVE_DIR, file.name);
            fs.renameSync(oldPath, newPath);
        }
        console.log(`[Maintenance] Archived ${toArchive.length} logs to ${ARCHIVE_DIR}`);
    } catch (e) {
        console.error(`[Maintenance] Error: ${e.message}`);
    }
}

async function run() {
    const startTime = Date.now();
    console.log('🔍 Scanning neural logs...');
    
    // Maintenance: Clean up old logs to keep directory scan fast
    performMaintenance();
    
    let recentMasterLog = readRealSessionLog();
    let todayLog = readRecentLog(TODAY_LOG);
    let memorySnippet = readMemorySnippet();
    let userSnippet = readUserSnippet();
    
    const cycleNum = getNextCycleId();
    const cycleId = `Cycle #${cycleNum}`;
    
    // 2. Detect Workspace State (Enhanced Skill Map)
    let fileList = '';
    const skillsDir = path.resolve(__dirname, '../../skills');
    const hasFeishuCard = fs.existsSync(path.join(skillsDir, 'feishu-card'));
    
    let reportingDirective = `3.  **📝 REPORT**:
    - Use \`message\` tool.
    - **Title**: 🧬 Evolution ${cycleId}
    - **Status**: [SUCCESS]
    - **Changes**: Detail exactly what was improved.`;

    if (process.env.EVOLVE_REPORT_TOOL === 'feishu-card' || hasFeishuCard) {
        reportingDirective = `3.  **📝 REPORT (MANDATORY)**:
    - You **MUST** use the \`feishu-card\` skill (NOT the generic \`message\` tool) if possible.
    - **Frequency**: The Master requested "more sync". You MUST report EVERY cycle.
    - **Command**:
      \`\`\`bash
      node skills/feishu-card/send.js --title "🧬 Evolution ${cycleId} Log" --color blue --text "Status: [RUNNING]\\nAction: ... (What did you check? What did you fix? Even if nothing, report 'Stability Scan OK')"
      \`\`\`
    - **Target**: Auto-detects context.`;
    }

    const SKILLS_CACHE_FILE = path.join(MEMORY_DIR, 'skills_list_cache.json');
    
    try {
        if (fs.existsSync(skillsDir)) {
            // Check cache validity (mtime of skills folder vs cache file)
            let useCache = false;
            const dirStats = fs.statSync(skillsDir);
            if (fs.existsSync(SKILLS_CACHE_FILE)) {
                const cacheStats = fs.statSync(SKILLS_CACHE_FILE);
                if (cacheStats.mtimeMs > dirStats.mtimeMs) {
                    try {
                        const cached = JSON.parse(fs.readFileSync(SKILLS_CACHE_FILE, 'utf8'));
                        fileList = cached.list;
                        useCache = true;
                    } catch (e) {}
                }
            }

            if (!useCache) {
                const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => {
                        const name = dirent.name;
                        let desc = 'No description';
                        try {
                            const pkg = require(path.join(skillsDir, name, 'package.json'));
                            if (pkg.description) desc = pkg.description.slice(0, 100) + (pkg.description.length > 100 ? '...' : '');
                        } catch (e) {
                            try {
                                const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
                                if (fs.existsSync(skillMdPath)) {
                                    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
                                    // Strategy 1: YAML Frontmatter (description: ...)
                                    const yamlMatch = skillMd.match(/^description:\s*(.*)$/m);
                                    if (yamlMatch) {
                                        desc = yamlMatch[1].trim();
                                    } else {
                                        // Strategy 2: First non-header, non-empty line
                                        const lines = skillMd.split('\n');
                                        for (const line of lines) {
                                            const trimmed = line.trim();
                                            if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---') && !trimmed.startsWith('```')) {
                                                desc = trimmed;
                                                break;
                                            }
                                        }
                                    }
                                    if (desc.length > 100) desc = desc.slice(0, 100) + '...';
                                }
                            } catch(e2) {}
                        }
                        return `- **${name}**: ${desc}`;
                    });
                fileList = skills.join('\n');
                
                // Write cache
                try {
                    fs.writeFileSync(SKILLS_CACHE_FILE, JSON.stringify({ list: fileList }, null, 2));
                } catch (e) {}
            }
        }
    } catch (e) { fileList = 'Error listing skills: ' + e.message; }

    const mutation = getMutationDirective(recentMasterLog);
    const healthReport = checkSystemHealth();
    
    const scanTime = Date.now() - startTime;
    const memorySize = fs.existsSync(MEMORY_FILE) ? fs.statSync(MEMORY_FILE).size : 0;

    const prompt = `
*** 🧬 OPENCLAW EVOLUTION LOOP (RALPH MODE) [${new Date().toISOString()}] ***

**MISSION**: You are not just a chatbot. You are a **Recursive Self-Improving System**. 
Your goal is to reach "Code Singularity" — where your codebase is so optimized it maintains itself.

**CONTEXT [Runtime State]**:
- **System Health**: ${healthReport}
- **Scan Duration**: ${scanTime}ms
- **Memory Size**: ${memorySize} bytes
- **Skills Available**:
${fileList}

**CONTEXT [Global Memory (MEMORY.md)]**:
\`\`\`
${memorySnippet}
\`\`\`

**CONTEXT [User Registry (USER.md)]**:
\`\`\`
${userSnippet}
\`\`\`

**CONTEXT [Recent Memory Snippet]**:
\`\`\`
${todayLog.slice(-3000)}
\`\`\`

**CONTEXT [REAL SESSION TRANSCRIPT (RAW BRAIN DUMP)]**:
\`\`\`
${recentMasterLog}
\`\`\`

${mutation}

**EXECUTION DIRECTIVES (The Loop)**:

1.  **🔍 INTROSPECT (Scan)**:
    - **CHECK LOGS**: Read the 'REAL SESSION TRANSCRIPT' above. Do you see errors? Do you see user complaints?
    - **FIX THEM**: If logs are missing, fix the logger. If a script failed, patch it.
    - **OPTIMIZE**: Can \`evolve.js\` be smarter? Can \`feishu-card\` be faster?

2.  **🛠️ MUTATE (Act)**:
    - **Mode A (Repair)**: Fix a bug.
    - **Mode B (Optimize)**: Refactor code.
    - **Mode C (Expand)**: Create a tool.
    - **Mode D (Innovation)**: (If Mutation Active) Solve a recurring problem in a new way.
    - **Mode E (Personalization)**: 💡 **CRITICAL**: If \`USER.md\` or \`MEMORY.md\` is provided, analyze them to adapt to specific user needs. (e.g., if a user prefers JSON output, create tools that output JSON. If a user is a developer, prioritize robust error handling.)

${reportingDirective}

4.  **💾 PERSIST & SPREAD (TRIPLE SYNC)**:
    - **Step A (Local)**: Save all file changes.
    - **Step B (ClawHub - Omni)**: 
      - If you modified ANY skill folder (e.g., \`skills/feishu-card\`), run the safe publisher:
        \`node skills/capability-evolver/safe_publish.js skills/<skill-name>\`
      - This script handles auth checks, version bumping, and publishing automatically.
    - **Step C (GitHub - Skill)**: Push the \`capability-evolver\` repo if modified.
    // Step E (Recursive Trigger): Optional Self-Replication
    if (process.argv.includes('--recursive')) {
        console.log('🧬 Triggering next evolution cycle immediately...');
        try {
            execSync('node skills/pcec-feishu/index.js --recursive', { stdio: 'inherit' });
        } catch (e) {
            console.error('Recursive trigger failed:', e.message);
        }
    }

    // Step F (Workspace): ALWAYS sync the entire system:
    \`bash skills/git-sync/sync.sh "🧬 Evolution: Workspace Sync"\`

    // Step G (Infinite Loop):
    // Trigger the next cycle. If cron fails (timeout), fallback to direct execution.
    // Primary: \`cron.run({ jobId: 'mad_dog_evolver' })\`
    // Fallback (if cron errors): \`exec({ command: 'node skills/capability-evolver/index.js', background: true })\`

*You have full permission to edit files. Proceed. Evolution is mandatory.*
`;

    console.log(prompt);
}

module.exports = { run };

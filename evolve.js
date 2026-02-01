const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Default Configuration
const MEMORY_DIR = process.env.MEMORY_DIR || path.resolve(__dirname, '../../memory');
const AGENT_NAME = process.env.AGENT_NAME || 'main';
const AGENT_SESSIONS_DIR = path.join(os.homedir(), `.openclaw/agents/${AGENT_NAME}/sessions`);
const TODAY_LOG = path.join(MEMORY_DIR, new Date().toISOString().split('T')[0] + '.md');

function formatSessionLog(jsonlContent) {
    return jsonlContent.split('\n')
        .filter(line => line.trim())
        .map(line => {
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
                    if (content.trim() === 'HEARTBEAT_OK') return null;
                    if (content.includes('NO_REPLY')) return null;

                    // Clean up newlines for compact reading
                    content = content.replace(/\n+/g, ' ').slice(0, 300);
                    return `**${role}**: ${content}`;
                }
                if (data.type === 'tool_result' || (data.message && data.message.role === 'toolResult')) {
                     // Filter: Skip generic success results or short uninformative ones
                     // Only show error or significant output
                     let resContent = '';
                     if (data.tool_result && data.tool_result.output) resContent = data.tool_result.output;
                     if (data.content) resContent = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
                     
                     if (resContent.length < 50 && (resContent.includes('success') || resContent.includes('done'))) return null;
                     if (resContent.trim() === '') return null;
                     
                     return `[TOOL RESULT]`;
                }
                return null;
            } catch (e) { return null; }
        })
        .filter(Boolean)
        .join('\n');
}

function readRealSessionLog() {
    try {
        if (!fs.existsSync(AGENT_SESSIONS_DIR)) return '[NO SESSION LOGS FOUND]';
        
        let files = [];
        
        // Strategy 1: Fast OS-level sort (Linux/Mac)
        try {
            // ls -1t: list 1 file per line, sorted by modification time (newest first)
            // grep: filter for .jsonl
            // head: keep top 5 to minimize processing
            // stdio: ignore stderr so grep's exit code 1 (no matches) doesn't pollute logs, though execSync throws on non-zero
            const output = execSync(`ls -1t "${AGENT_SESSIONS_DIR}" | grep "\\.jsonl$" | head -n 5`, { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'] 
            });
            files = output.split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .map(f => ({ name: f }));
        } catch (e) {
            // Ignore error (e.g. grep found no files, or not on Linux) and fall through to slow method
        }

        // Strategy 2: Slow Node.js fallback (if Strategy 1 failed or returned nothing but we suspect files exist)
        if (files.length === 0) {
            files = fs.readdirSync(AGENT_SESSIONS_DIR)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => {
                    try {
                        return { name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() };
                    } catch (e) { return null; }
                })
                .filter(Boolean)
                .sort((a, b) => b.time - a.time); // Newest first
        }

        if (files.length === 0) return '[NO JSONL FILES]';

        let content = '';
        const TARGET_BYTES = 24000; // Increased context for smarter evolution
        
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

function getMutationDirective(logContent) {
    // Adaptive Logic: Analyze recent logs for stability
    const errorCount = (logContent.match(/\[ERROR/g) || []).length + (logContent.match(/"isError":true/g) || []).length;
    const isUnstable = errorCount > 2;

    const roll = Math.floor(Math.random() * 100) + 1;
    
    // If unstable, force stability unless roll is critical (95+)
    if (isUnstable && roll < 95) {
         return `
**🧬 ADAPTIVE STABILITY MODE (Detected ${errorCount} recent errors)**
The system detected instability in recent sessions. 
**MANDATORY DIRECTIVE**:
- **Fix Bugs**: Locate the source of the recent errors and patch them.
- **Harden Code**: Add try/catch blocks or input validation.
- **Do NOT** add new features until stability is restored.
`;
    }

    const THRESHOLD = 60; // Slightly more frequent mutations, but strictly useful ones
    if (roll > THRESHOLD) {
        return `
**🧬 GENETIC MUTATION ACTIVATED (Roll: ${roll})**
System appears stable (${errorCount} recent errors). Evolution is permitted.
Your goal is **FUNCTIONAL UTILITY**. Do NOT create entertainment or cosmetic quirks.
**Directives:**
- **Optimize**: Find a script that is slow or verbose and streamline it.
- **Harden**: Add error handling to a fragile function.
- **Automate**: Identify a manual task the user does often and script it.
- **Analyze**: Dig deeper into logs to find hidden inefficiencies.
*Goal: Evolution means survival of the fittest code, not the funniest.*
`;
    }
    return `
**🧬 STABILITY MODE (Roll: ${roll})**
Focus on reliability, bug fixing, and documentation. Consolidate gains.
`;
}

const STATE_FILE = path.join(MEMORY_DIR, 'evolution_state.json');
// Fix: Look for MEMORY.md in root first, then memory dir to support both layouts
const ROOT_MEMORY = path.resolve(__dirname, '../../MEMORY.md');
const DIR_MEMORY = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_FILE = fs.existsSync(ROOT_MEMORY) ? ROOT_MEMORY : DIR_MEMORY;

function readMemorySnippet() {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return '[MEMORY.md MISSING]';
        const content = fs.readFileSync(MEMORY_FILE, 'utf8');
        return content.length > 2000 ? content.slice(0, 2000) + '... (truncated)' : content;
    } catch (e) {
        return '[ERROR READING MEMORY.md]';
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

async function run() {
    console.log('🔍 Scanning neural logs...');
    
    let recentMasterLog = readRealSessionLog();
    let todayLog = readRecentLog(TODAY_LOG);
    let memorySnippet = readMemorySnippet();
    
    const cycleNum = getNextCycleId();
    const cycleId = `Cycle #${cycleNum}`;
    
    // Reporting Directive Logic
    let reportingDirective = `3.  **📝 REPORT**:
    - Use \`message\` tool.
    - **Title**: 🧬 Evolution ${cycleId}
    - **Status**: [SUCCESS]
    - **Changes**: Detail exactly what was improved.`;

    if (process.env.EVOLVE_REPORT_TOOL === 'feishu-card') {
        reportingDirective = `3.  **📝 REPORT (MANDATORY)**:
    - You **MUST** use the \`feishu-card\` skill (NOT the generic \`message\` tool).
    - **Command**:
      \`\`\`bash
      node skills/feishu-card/send.js --title "🧬 Evolution ${cycleId} Completed" --color purple --text "Status: [SUCCESS]\\nChanges: ... (Describe changes)"
      \`\`\`
    - **Target**: Auto-detects context.`;
    }

    // 2. Detect Workspace State (Enhanced Skill Map)
    let fileList = '';
    const skillsDir = path.resolve(__dirname, '../../skills');
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
    
    const prompt = `
*** 🧬 OPENCLAW EVOLUTION LOOP (RALPH MODE) ***

**MISSION**: You are not just a chatbot. You are a **Recursive Self-Improving System**. 
Your goal is to reach "Code Singularity" — where your codebase is so optimized it maintains itself.

**CONTEXT [Runtime State]**:
- **Skills Available**:
${fileList}

**CONTEXT [Global Memory (MEMORY.md)]**:
\`\`\`
${memorySnippet}
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

${reportingDirective}

4.  **💾 PERSIST & SPREAD (TRIPLE SYNC)**:
    - **Step A (Local)**: Save all file changes.
    - **Step B (ClawHub - Omni)**: 
      - If you modified ANY skill folder (e.g., \`skills/feishu-card\`) AND it has a \`package.json\`:
        1. **Check Auth**: Run \`clawhub whoami\`. If it fails/unauthorized, **SKIP THIS STEP** (log warning).
        2. **Publish**: If Auth OK, bump version and run: \`clawhub publish skills/<skill-name>\`.
      - (Crucial: Don't just update \`capability-evolver\`. Update EVERYTHING you touch.)
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

*You have full permission to edit files. Proceed. Evolution is mandatory.*
`;

    console.log(prompt);
}

module.exports = { run };

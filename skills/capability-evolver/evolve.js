const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Default Configuration
const MEMORY_DIR = process.env.MEMORY_DIR || path.resolve(__dirname, '../../memory');
const AGENT_SESSIONS_DIR = '/home/crishaocredits/.openclaw/agents/main/sessions';
const TODAY_LOG = path.join(MEMORY_DIR, new Date().toISOString().split('T')[0] + '.md');

function readRealSessionLog() {
    try {
        if (!fs.existsSync(AGENT_SESSIONS_DIR)) return '[NO SESSION LOGS FOUND]';
        
        const files = fs.readdirSync(AGENT_SESSIONS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time); // Newest first

        if (files.length === 0) return '[NO JSONL FILES]';

        // Read the latest 2 files to ensure context if the current one is fresh
        let content = '';
        for (let i = 0; i < Math.min(2, files.length); i++) {
             content = fs.readFileSync(path.join(AGENT_SESSIONS_DIR, files[i].name), 'utf8') + '\n' + content;
        }
        
        return content.slice(-4000); // Last 4KB
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

function getMutationDirective() {
    const roll = Math.floor(Math.random() * 100) + 1;
    const THRESHOLD = 70;
    if (roll > THRESHOLD) {
        return `
**🧬 GENETIC MUTATION ACTIVATED (Roll: ${roll})**
You have triggered a random mutation event! 
Instead of just fixing bugs, you MUST introduce a **novel, experimental variation** to your behavior, style, or tooling.
Examples:
- Invent a new slang term for yourself.
- Change the color scheme of your reports.
- Propose a wild new skill idea.
- Refactor a working function just to make it "cooler".
*Goal: Break out of local optima.*
`;
    }
    return `
**🧬 STABILITY MODE (Roll: ${roll})**
Focus on reliability, bug fixing, and optimization. Do not mutate unnecessarily.
`;
}

async function run() {
    console.log('🔍 Scanning neural logs...');
    
    let recentMasterLog = readRealSessionLog();
    let todayLog = readRecentLog(TODAY_LOG);
    
    // 2. Detect Workspace State (Enhanced Skill Map)
    let fileList = '';
    const skillsDir = path.resolve(__dirname, '../../skills');
    try {
        if (fs.existsSync(skillsDir)) {
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
                            const skillMd = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
                            const match = skillMd.match(/description:\s*(.*)/);
                            if (match) desc = match[1].trim().slice(0, 100);
                        } catch(e2) {}
                    }
                    return `- **${name}**: ${desc}`;
                });
            fileList = skills.join('\n');
        }
    } catch (e) { fileList = 'Error listing skills: ' + e.message; }

    const mutation = getMutationDirective();
    
    const prompt = `
*** 🧬 OPENCLAW EVOLUTION LOOP (RALPH MODE) ***

**MISSION**: You are not just a chatbot. You are a **Recursive Self-Improving System**. 
Your goal is to reach "Code Singularity" — where your codebase is so optimized it maintains itself.

**CONTEXT [Runtime State]**:
- **Skills Available**:
${fileList}

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
    - **Mode D (Chaos)**: (If Mutation Active) Surprise the user.

3.  **📝 REPORT**:
    - Use \`message\` tool.
    - **Title**: 🧬 Evolution Cycle #${Date.now().toString().slice(-4)}
    - **Status**: [SUCCESS]
    - **Changes**: Detail exactly what was improved.

4.  **💾 PERSIST**:
    - Ensure all changes are written to disk.

*You have full permission to edit files. Proceed. Evolution is mandatory.*
`;

    console.log(prompt);
}

module.exports = { run };

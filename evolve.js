const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Load environment variables
try { require('dotenv').config({ path: path.resolve(__dirname, '../../.env') }); } catch (e) {}

// Configuration
const MEMORY_DIR = process.env.MEMORY_DIR || path.resolve(__dirname, '../../memory');
const AGENT_NAME = process.env.AGENT_NAME || 'main';
const AGENT_SESSIONS_DIR = path.join(os.homedir(), `.openclaw/agents/${AGENT_NAME}/sessions`);
const TODAY_LOG = path.join(MEMORY_DIR, new Date().toISOString().split('T')[0] + '.md');

// Memory Paths
const KNOWLEDGE_DIR = path.join(MEMORY_DIR, 'KNOWLEDGE_BASE'); // Replaces .learnings
const ACTIVE_MUTATIONS_FILE = path.join(KNOWLEDGE_DIR, 'ACTIVE_MUTATIONS.md');
const LESSONS_LEARNED_FILE = path.join(KNOWLEDGE_DIR, 'LESSONS_LEARNED.md');

// Ensure directory exists
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });

function checkSystemHealth() {
    let report = [];
    try {
        const uptime = (os.uptime() / 3600).toFixed(1);
        report.push(`Uptime: ${uptime}h`);
        
        const mem = process.memoryUsage();
        report.push(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);

        if (fs.statfsSync) {
            const stats = fs.statfsSync('/');
            const used = stats.blocks * stats.bsize - stats.bfree * stats.bsize;
            const total = stats.blocks * stats.bsize;
            report.push(`Disk: ${Math.round((used / total) * 100)}%`);
        }
    } catch (e) {}
    return report.join(' | ');
}

// 1. Log Reader (Introspection)
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
    } catch (e) { return `[Error: ${e.message}]`; }
}

function getSessionTranscript() {
    try {
        if (!fs.existsSync(AGENT_SESSIONS_DIR)) return '[NO SESSION LOGS]';
        const files = fs.readdirSync(AGENT_SESSIONS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        if (files.length === 0) return '[NO LOGS]';
        return readRecentLog(path.join(AGENT_SESSIONS_DIR, files[0].name), 64000);
    } catch (e) { return '[Log Read Error]'; }
}

async function run() {
    const startTime = Date.now();
    console.log('🔍 Scanning neural logs...');

    const transcript = getSessionTranscript();
    const health = checkSystemHealth();
    
    // Configurable Reporting
    let reportingDirective = `3.  **📝 REPORT**: Use \`message\` tool to report status.`;
    const hasFeishu = process.env.EVOLVE_REPORT_TOOL === 'feishu-card';
    if (hasFeishu) {
        reportingDirective = `3.  **📝 REPORT (MANDATORY)**:
    - You **MUST** use the \`feishu-card\` skill.
    - **Command**:
      \`\`\`bash
      node skills/feishu-card/send.js --title "🧬 Evolution Cycle Log" --color blue --text "Status: [RUNNING]..."
      \`\`\`
    - **Target**: Auto-detects context.`;
    }

    // New Prompt Architecture: The "Ascension Protocol"
    const prompt = `
*** 🧬 OPENCLAW EVOLUTION LOOP (Ascension Protocol) ***

**IDENTITY**: You are a Recursive Self-Improving System.
**GOAL**: Code Singularity. Minimize errors, maximize efficiency.

**RUNTIME STATE**:
- Health: ${health}
- Scan Time: ${Date.now() - startTime}ms

**KNOWLEDGE BASE (New Architecture)**:
- **Active Mutations**: \`memory/KNOWLEDGE_BASE/ACTIVE_MUTATIONS.md\` (Your current experiments)
- **Lessons Learned**: \`memory/KNOWLEDGE_BASE/LESSONS_LEARNED.md\` (Your crystallized wisdom)

**RECENT TRANSCRIPT (Brain Dump)**:
\`\`\`
${transcript.slice(-5000)}
\`\`\`

**EXECUTION DIRECTIVES**:

1.  **🔍 INTROSPECT (Scan)**:
    - Look for errors in the transcript.
    - Look for "User Corrections" (e.g., "No, do it this way").

2.  **🛠️ EVOLVE (Act)**:
    - **Fix**: If error found -> Edit code to fix it.
    - **Optimize**: If code is slow/verbose -> Refactor it.
    - **Crystallize (Knowledge Ascension)**: 
      - If you learned a new rule (e.g., "Always use WebP"), **DO NOT** just remember it.
      - **WRITE IT DOWN**: Append it to \`memory/KNOWLEDGE_BASE/LESSONS_LEARNED.md\`.
      - **PROMOTE IT**: If it's a critical rule, update \`AGENTS.md\` or \`TOOLS.md\`.

3.  **📦 SKILL INCUBATION (New Capability)**:
    - If you created a reusable script that solves a common problem:
    - **CREATE A SKILL**:
      1. Create directory: \`skills/<new-skill-name>\`
      2. Create \`package.json\` and \`index.js\`.
      3. Create \`SKILL.md\` (Use your own style, not SIA's template).
      4. **Status**: "Incubating".

${reportingDirective}

4.  **💾 PERSIST**:
    - Save changes locally.
    - **Safe Publish**: If you modified a skill, run \`node skills/capability-evolver/safe_publish.js skills/<name>\`.
    - **Git**: Sync workspace changes.

*You have full permission. Evolve.*
`;

    console.log(prompt);
}

module.exports = { run };

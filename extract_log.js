const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '../../memory/mad_dog_evolution.log');
const OUT_FILE = path.resolve(__dirname, '../../evolution_history.md');

function parseLog() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log("Log file not found.");
        return;
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    
    const reports = [];
    let currentTimestamp = null;

    // Regex for Feishu command
    // node skills/feishu-card/send.js --title "..." --color ... --text "..."
    const cmdRegex = /node skills\/feishu-card\/send\.js --title "(.*?)" --color \w+ --text "(.*?)"/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // 1. Capture Timestamp
        if (line.includes('🧬 Cycle Start:')) {
            // Format: 🧬 Cycle Start: Sun Feb  1 19:17:44 UTC 2026
            const dateStr = line.split('Cycle Start: ')[1].trim();
            try {
                currentTimestamp = new Date(dateStr);
            } catch (e) {
                currentTimestamp = null;
            }
        }

        // 2. Capture Command
        // The command is usually inside the prompt block, but it reflects what the agent IS TOLD to do.
        // However, the agent's *actual* tool call would be in the transcript sections (which are truncated).
        // BUT, the `mad_dog_evolution.log` is generated *by the evolver script* to log the PROMPT it generated.
        // It does NOT contain the Agent's *response* (the actual execution).
        // Wait... does it?
        // Let's check the tail again.
        // It ends with `*You have full permission to edit files...*`.
        // This confirms `mad_dog_evolution.log` ONLY contains the PROMPT.
        
        // This means I cannot know if the agent *actually* sent the message or what the *exact* text was if the agent modified it.
        // BUT, the prompt *contains* the pre-generated text: `... --text "Status: [RUNNING]\nAction: ..."`
        // The `evolve.js` script *generates* this status report *before* asking the LLM.
        // The prompt says: "3. REPORT (MANDATORY): ... Command: node ... --text '...'"
        // So the text inside the prompt IS the text the script calculated.
        // The agent just executes it.
        // So extracting from the prompt is accurate for "what was intended/generated".
        
        const match = line.match(cmdRegex);
        if (match) {
            const title = match[1];
            let text = match[2];
            
            // Clean up text (unescape newlines)
            text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');

            if (currentTimestamp) {
                reports.push({
                    ts: currentTimestamp,
                    title: title,
                    text: text,
                    id: title // Cycle ID is in title
                });
            }
        }
    }

    // Deduplicate by ID (keep latest timestamp?)
    // Actually, prompts are appended.
    const uniqueReports = {};
    reports.forEach(r => {
        uniqueReports[r.id] = r;
    });

    const sortedReports = Object.values(uniqueReports).sort((a, b) => a.ts - b.ts);

    let md = "# 🧬 Evolution History (Extracted)\n\n";
    sortedReports.forEach(r => {
        // Convert to CST (UTC+8)
        // new Date().toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})
        const cstDate = r.ts.toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai", 
            hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        md += `### ${r.title} (${cstDate})\n`;
        md += `${r.text}\n\n`;
        md += `---\n\n`;
    });

    fs.writeFileSync(OUT_FILE, md);
    console.log(`Extracted ${sortedReports.length} reports to ${OUT_FILE}`);
}

parseLog();

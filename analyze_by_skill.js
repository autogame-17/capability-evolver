const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '../../evolution_history_full.md');
const OUT_FILE = path.resolve(__dirname, '../../evolution_detailed_report.md');

function analyzeEvolution() {
    if (!fs.existsSync(LOG_FILE)) {
        console.error("Source file missing.");
        return;
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    // Split by divider
    const entries = content.split('---').map(e => e.trim()).filter(e => e.length > 0);

    const skillUpdates = {}; // Map<SkillName, Array<Changes>>
    const generalUpdates = []; // Array<Changes>

    // Regex to detect skills/paths
    // e.g. `skills/feishu-card/send.js` or **Target**: `skills/git-sync`
    const skillRegex = /skills\/([a-zA-Z0-9\-_]+)/;
    const actionRegex = /Action:\s*([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i; // Capture Action text
    const statusRegex = /Status:\s*\[?([A-Z\s_]+)\]?/i;

    entries.forEach(entry => {
        // Extract basic info
        const statusMatch = entry.match(statusRegex);
        const status = statusMatch ? statusMatch[1].trim().toUpperCase() : 'UNKNOWN';
        
        // Skip routine checks if we want a *detailed evolution* report (focus on changes)
        // But user asked for "what happened", so routine scans might be boring unless they found something.
        // Let's filter out "STABILITY" or "RUNNING" unless there is a clear "Mutated" or "Fixed" keyword.
        const isInteresting = 
            entry.includes('Fixed') || 
            entry.includes('Hardened') || 
            entry.includes('Optimized') || 
            entry.includes('Patched') || 
            entry.includes('Created') || 
            entry.includes('Added') ||
            status === 'SUCCESS' ||
            status === 'COMPLETED';

        if (!isInteresting) return;

        // Find associated skill
        const skillMatch = entry.match(skillRegex);
        let skillName = 'General / System';
        if (skillMatch) {
            skillName = skillMatch[1];
        } else {
            // Try heuristics
            if (entry.toLowerCase().includes('feishu card')) skillName = 'feishu-card';
            else if (entry.toLowerCase().includes('git sync')) skillName = 'git-sync';
            else if (entry.toLowerCase().includes('logger')) skillName = 'interaction-logger';
            else if (entry.toLowerCase().includes('evolve')) skillName = 'capability-evolver';
        }

        // Extract description
        let description = "";
        const actionMatch = entry.match(actionRegex);
        if (actionMatch) {
            description = actionMatch[1].trim();
        } else {
            // Fallback: take lines that look like bullet points or text after header
            const lines = entry.split('\n');
            description = lines.filter(l => l.match(/^[•\-\*]|\w/)).slice(1).join('\n').trim();
        }

        // Clean up description (remove duplicate "Action:" prefix if captured)
        description = description.replace(/^Action:\s*/i, '');

        if (!skillUpdates[skillName]) skillUpdates[skillName] = [];
        
        // Dedup descriptions slightly (simple check)
        const isDuplicate = skillUpdates[skillName].some(u => u.desc.includes(description.substring(0, 20)));
        if (!isDuplicate) {
            // Extract Date if possible
            const dateMatch = entry.match(/\((\d{4}\/\d{1,2}\/\d{1,2}.*?)\)/);
            const date = dateMatch ? dateMatch[1] : 'Unknown';
            
            skillUpdates[skillName].push({
                date,
                status,
                desc: description
            });
        }
    });

    // Generate Markdown
    let md = "# 🧬 Detailed Evolution Report (By Skill)\n\n> Comprehensive breakdown of system mutations.\n\n";

    // Sort skills alphabetically
    const sortedSkills = Object.keys(skillUpdates).sort();

    sortedSkills.forEach(skill => {
        md += `## 📦 ${skill}\n`;
        const updates = skillUpdates[skill];
        
        updates.forEach(u => {
            // Icon based on content
            let icon = '🔧';
            const lowerDesc = u.desc.toLowerCase();
            if (lowerDesc.includes('optimiz')) icon = '⚡';
            if (lowerDesc.includes('secur') || lowerDesc.includes('harden') || lowerDesc.includes('permission')) icon = '🛡️';
            if (lowerDesc.includes('fix') || lowerDesc.includes('patch')) icon = '🚑';
            if (lowerDesc.includes('creat') || lowerDesc.includes('add')) icon = '✨';

            md += `### ${icon} ${u.date}\n`;
            md += `${u.desc}\n\n`;
        });
        md += `---\n`;
    });

    fs.writeFileSync(OUT_FILE, md);
    console.log(`Generated report for ${sortedSkills.length} skills.`);
}

analyzeEvolution();

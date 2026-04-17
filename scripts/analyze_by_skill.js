const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(REPO_ROOT, 'evolution_history_full.md');
const OUT_FILE = path.join(REPO_ROOT, 'evolution_detailed_report.md');

function analyzeEvolution() {
    if (!fs.existsSync(LOG_FILE)) {
        console.error("Source file missing.");
        return;
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');

    // Split entries
    const entries = content
        .split('---')
        .map(e => e.trim())
        .filter(e => e.length > 0);

    const skillUpdates = {};
    const generalUpdates = [];
    const changeTypeStats = {};

    // Regex
    const skillRegex = /skills\/([a-zA-Z0-9\-_]+)/;
    const actionRegex = /Action:\s*([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i;
    const statusRegex = /Status:\s*\[?([A-Z\s_]+)\]?/i;

    function detectChangeType(text) {
        if (/fix(ed)?/i.test(text)) return 'Fix';
        if (/add(ed)?|feature/i.test(text)) return 'Feature';
        if (/refactor(ed)?/i.test(text)) return 'Refactor';
        if (/optimi[sz]e(d)?/i.test(text)) return 'Optimize';
        if (/remove(d)?/i.test(text)) return 'Remove';
        return 'Other';
    }

    entries.forEach(entry => {
        const statusMatch = entry.match(statusRegex);
        const status = statusMatch ? statusMatch[1].trim().toUpperCase() : 'UNKNOWN';

        const actionMatch = entry.match(actionRegex);
        const actionText = actionMatch ? actionMatch[1].trim() : '';

        const skillMatch = entry.match(skillRegex);
        const skill = skillMatch ? skillMatch[1] : null;

        const changeType = detectChangeType(actionText);

        // Count change types
        changeTypeStats[changeType] = (changeTypeStats[changeType] || 0) + 1;

        const updateObj = {
            status,
            action: actionText,
            type: changeType
        };

        if (skill) {
            if (!skillUpdates[skill]) skillUpdates[skill] = [];
            skillUpdates[skill].push(updateObj);
        } else {
            generalUpdates.push(updateObj);
        }
    });

    // Build report
    let report = `# Evolution Detailed Report\n\n`;

    // Most active skills
    report += `## 🔝 Most Active Skills\n`;
    const sortedSkills = Object.entries(skillUpdates)
        .sort((a, b) => b[1].length - a[1].length);

    sortedSkills.forEach(([skill, updates]) => {
        report += `- ${skill}: ${updates.length} changes\n`;
    });

    // Change type distribution
    report += `\n## 📊 Change Type Distribution\n`;
    Object.entries(changeTypeStats).forEach(([type, count]) => {
        report += `- ${type}: ${count}\n`;
    });

    // Detailed skill evolution
    report += `\n## 🧠 Skill-wise Evolution\n`;
    sortedSkills.forEach(([skill, updates]) => {
        report += `\n### ${skill}\n`;
        updates.forEach(u => {
            report += `- [${u.type}] (${u.status}) ${u.action}\n`;
        });
    });

    // General updates
    if (generalUpdates.length > 0) {
        report += `\n## 🌐 General Updates\n`;
        generalUpdates.forEach(u => {
            report += `- [${u.type}] (${u.status}) ${u.action}\n`;
        });
    }

    fs.writeFileSync(OUT_FILE, report, 'utf8');
    console.log("Detailed evolution report generated.");
}

analyzeEvolution();            entry.includes('Hardened') || 
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
    let md = "# Detailed Evolution Report (By Skill)\n\n> Comprehensive breakdown of system changes.\n\n";

    // Sort skills alphabetically
    const sortedSkills = Object.keys(skillUpdates).sort();

    sortedSkills.forEach(skill => {
        md += `## ${skill}\n`;
        const updates = skillUpdates[skill];
        
        updates.forEach(u => {
            // Icon based on content
            let icon = '*';
            const lowerDesc = u.desc.toLowerCase();
            if (lowerDesc.includes('optimiz')) icon = '[optimize]';
            if (lowerDesc.includes('secur') || lowerDesc.includes('harden') || lowerDesc.includes('permission')) icon = '[security]';
            if (lowerDesc.includes('fix') || lowerDesc.includes('patch')) icon = '[repair]';
            if (lowerDesc.includes('creat') || lowerDesc.includes('add')) icon = '[add]';

            md += `### ${icon} ${u.date}\n`;
            md += `${u.desc}\n\n`;
        });
        md += `---\n`;
    });

    fs.writeFileSync(OUT_FILE, md);
    console.log(`Generated report for ${sortedSkills.length} skills.`);
}

analyzeEvolution();


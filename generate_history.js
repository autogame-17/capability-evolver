const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Separator for git log parsing (something unlikely to be in commit messages)
const SEP = '|||';

try {
    // Git command:
    // --reverse: Oldest to Newest (Time Sequence)
    // --grep: Filter by keyword
    // --format: Hash, Date (ISO), Author, Subject, Body
    const cmd = `git log --reverse --grep="🧬 Evolution" --format="%H${SEP}%ai${SEP}%an${SEP}%s${SEP}%b"`;
    
    console.log('Executing git log...');
    const output = execSync(cmd, { 
        encoding: 'utf8', 
        cwd: path.resolve(__dirname, '../../'),
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer just in case
    });

    const entries = output.split('\n').filter(line => line.trim().length > 0);
    
    let markdown = '# 🧬 Evolution History (Time Sequence)\n\n';
    markdown += '> **Filter**: "🧬 Evolution"\n';
    markdown += '> **Timezone**: CST (UTC+8)\n\n';
    
    let count = 0;

    entries.forEach(entry => {
        const parts = entry.split(SEP);
        if (parts.length < 4) return;

        const hash = parts[0];
        const dateStr = parts[1];
        const author = parts[2];
        const subject = parts[3];
        const body = parts[4] || '';

        // Parse Date and Convert to UTC+8
        const date = new Date(dateStr);
        // Add 8 hours (28800000 ms) to UTC timestamp to shift it
        // Then formatting it as ISO will look like UTC but represent CST values
        const cstDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        
        // Format: YYYY-MM-DD HH:mm:ss
        const timeStr = cstDate.toISOString().replace('T', ' ').substring(0, 19);

        markdown += `## ${timeStr}\n`;
        markdown += `- **Commit**: \`${hash.substring(0, 7)}\`\n`;
        markdown += `- **Subject**: ${subject}\n`;
        
        if (body.trim()) {
            // Indent body for better readability
            const formattedBody = body.trim().split('\n').map(l => `> ${l}`).join('\n');
            markdown += `- **Details**:\n${formattedBody}\n`;
        }
        markdown += '\n';
        count++;
    });

    const outPath = path.resolve(__dirname, '../../memory/evolution_history.md');
    fs.writeFileSync(outPath, markdown);
    
    console.log(`Successfully generated report with ${count} entries.`);
    console.log(`Saved to: ${outPath}`);

} catch (e) {
    console.error('Error generating history:', e.message);
    process.exit(1);
}

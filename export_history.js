const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const DOC_TOKEN = 'NwV1dKCLyoPdIvx3biRcKS1Jnwg'; // The new doc
const LOG_FILE = path.resolve(__dirname, '../../memory/mad_dog_evolution.log');
const TOKEN_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

async function exportEvolutionHistory() {
    let token;
    try { token = JSON.parse(fs.readFileSync(TOKEN_FILE)).token; } catch(e) {}
    if (!token) return console.error("No token");

    let logContent = '';
    try { logContent = fs.readFileSync(LOG_FILE, 'utf8'); } catch(e) { return console.error("No log file"); }

    // Parse Log
    const cycles = [];
    const regex = /Evolution Cycle #(\d+)([\s\S]*?)(?:Cycle End|System:)/g;
    let match;
    while ((match = regex.exec(logContent)) !== null) {
        let details = match[2].trim();
        // Clean up details
        details = details.replace(/\[.*?\]/g, '').replace(/\n+/g, '\n').trim();
        if (details.length > 500) details = details.substring(0, 500) + '...';
        
        cycles.push({
            id: match[1],
            content: details
        });
    }

    if (cycles.length === 0) {
        // Fallback: Just dump the last 50 lines
        cycles.push({ id: "Unknown", content: logContent.split('\n').slice(-50).join('\n') });
    }

    // Reverse to show latest first
    cycles.reverse();

    // Format for Feishu Doc (Markdown)
    let markdown = "# 🧬 Evolution History (Mad Dog) \n\n> Auto-generated report of self-improvement cycles.\n\n";
    
    // Split into chunks if too big
    const chunks = [];
    let currentChunk = markdown;
    
    for (const cycle of cycles) {
        const entry = `### Cycle #${cycle.id}\n${cycle.content}\n\n---\n\n`;
        if (currentChunk.length + entry.length > 8000) { // Safety limit
            chunks.push(currentChunk);
            currentChunk = entry;
        } else {
            currentChunk += entry;
        }
    }
    chunks.push(currentChunk);

    // Append Chunks
    console.log(`Exporting ${chunks.length} chunks...`);
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`Uploading Chunk ${i+1}/${chunks.length}...`);
        
        // Fallback: Send as Code Block to avoid parsing errors
        const blocks = [{
            block_type: 14, // Code
            code: {
                style: { language: 1 }, // Plain Text
                elements: [{ text_run: { content: chunk, text_element_style: {} } }]
            }
        }];

        const res = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_TOKEN}/blocks/${DOC_TOKEN}/children`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({ children: blocks })
        });
        
        const data = await res.json();
        if (data.code !== 0) console.error(`Chunk ${i+1} failed:`, JSON.stringify(data));
        else console.log(`Chunk ${i+1} success.`);
        
        await new Promise(r => setTimeout(r, 500));
    }
}

exportEvolutionHistory();

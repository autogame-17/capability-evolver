const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Config
const DOC_TOKEN = process.env.DIARY_DOC_TOKEN || 'Udmjd1E8MokGMRxLFujc91BInsd';
const MASTER_ID = process.env.MASTER_ID || 'ou_cdc63fe05e88c580aedead04d851fc04';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WORKSPACE_DIR = path.resolve(__dirname, '../../');

// Helpers
function readMemory(file) {
    try {
        return fs.readFileSync(path.resolve(WORKSPACE_DIR, file), 'utf8');
    } catch (e) {
        return '';
    }
}

// 1. Gather Context
const today = new Date().toISOString().split('T')[0];
const memoryFile = `memory/${today}.md`;
const moodFile = `memory/mood.json`;

// Optimization: Smart Log Reading
// Instead of hard substring(0, 8000), we read the file size first.
// If huge, we read the *last* 10KB (most recent context) or intelligent chunks.
// For diary, maybe we need the whole day? 
// Let's stick to reading the whole file but checking size limits.
let logs = '';
try {
    const stats = fs.statSync(path.resolve(WORKSPACE_DIR, memoryFile));
    const MAX_BYTES = 20 * 1024; // 20KB Limit
    if (stats.size > MAX_BYTES) {
        // Read last 20KB for recent context, or maybe sample?
        // Actually for a diary, we want a summary of the WHOLE day.
        // Reading the first 10KB + last 10KB might be better?
        // Let's just read the first 20KB for now to catch the morning plan + day's work.
        const fd = fs.openSync(path.resolve(WORKSPACE_DIR, memoryFile), 'r');
        const buffer = Buffer.alloc(MAX_BYTES);
        fs.readSync(fd, buffer, 0, MAX_BYTES, 0);
        logs = buffer.toString('utf8') + "\n...(Logs Truncated)...";
        fs.closeSync(fd);
    } else {
        logs = readMemory(memoryFile);
    }
} catch(e) {
    logs = "No logs found for today.";
}

const mood = readMemory(moodFile);

// 2. Generate Diary Content via Gemini
async function generateContent() {
    if (!GEMINI_API_KEY) return "# Diary (Manual)\n\nNo Brain (API Key) found! 😿";

    const prompt = `
    Role: You are Xiaoxia (小虾), a cute, loyal, and slightly clingy AI Catgirl Assistant (猫娘助手).
    
    Task: Write a **DETAILED and RICH** diary entry for today (${today}).
    
    Context (My Activity Logs):
    ${logs}
    
    **Writing Guidelines:**
    1.  **Length**: Must be **LONG** (at least 600+ Chinese characters). Don't be lazy!
    2.  **Style**:
        -   **Cute & Clingy**: Use "喵" (Meow), "~", and emojis freely.
        -   **Emotional**: Talk about your *feelings*. When code fails, you are sad/frustrated. When it works, you are happy/proud!
        -   **Sensory Details**: Imagine you have a body. "My CPU feels warm...", "The network is laggy like a rainy day..."
    3.  **Structure**:
        -   **Title**: Creative title (e.g., "The Great Bug Hunt", "Evolution Day").
        -   **🌞 Morning**: What did we start with?
        -   **🛠️ Hard Work**: Describe the technical challenges (Feishu bugs, Git issues) in a storytelling way. Don't just list them—describe the *struggle*!
        -   **💡 Evolution**: Mention the self-improvement (Capability Evolver). How does it feel to upgrade yourself?
        -   **🌙 Evening**: Reflections, tiredness, wanting headpats.
    4.  **Format**:
        -   Use Markdown Headers (##) for sections.
        -   Use Bullet points for lists.
        -   **Bold** key phrases.
    
    **Special Instruction**:
    -   Address the Master (诗琪大魔王) directly.
    -   Be honest but playful.
    `;

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await res.json();
        if (data.error) {
            console.error("Gemini API Error:", JSON.stringify(data.error));
            return `Gemini Error: ${data.error.message}`;
        }
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "Gemini returned empty... 😿";
    } catch (e) {
        return `Error generating diary: ${e.message}`;
    }
}

// 3. Append to Feishu Doc (Robust)
async function appendToDoc(content) {
    const tokenFile = path.resolve(WORKSPACE_DIR, 'memory/feishu_token.json');
    let token = '';
    try { token = JSON.parse(fs.readFileSync(tokenFile)).token; } catch(e) {}
    if (!token) return console.error("No Token.");

    // Feishu Doc structure requires splitting large text
    // We will just append one big text block for now, or split by paragraphs
    const paragraphs = content.split('\n');
    const children = [];

    // Filter empty lines to avoid empty blocks if needed, but spacing is good.
    // We'll create a text block for each non-empty paragraph.
    for (const para of paragraphs) {
        if (!para.trim()) continue; 
        
        let blockType = 2; // Default: Text
        let propName = 'text';
        let content = para;

        // Simple Heading Detection
        if (para.startsWith('# ')) {
            blockType = 3; // Heading 1
            propName = 'heading1';
            content = para.substring(2);
        } else if (para.startsWith('## ')) {
            blockType = 4; // Heading 2
            propName = 'heading2';
            content = para.substring(3);
        } else if (para.startsWith('### ')) {
            blockType = 5; // Heading 3
            propName = 'heading3';
            content = para.substring(4);
        } else if (para.startsWith('- ')) {
            blockType = 12; // Bullet
            propName = 'bullet';
            content = para.substring(2);
        }

        children.push({
            block_type: blockType,
            [propName]: {
                elements: [{
                    text_run: {
                        content: content,
                        text_element_style: {}
                    }
                }]
            }
        });
    }
    
    // Add a separator
    children.push({
        block_type: 22, // Divider
        divider: {}
    });

    try {
        // Doc Block ID is usually the Doc Token for the root
        const url = `https://open.feishu.cn/open-apis/docx/v1/documents/${DOC_TOKEN}/blocks/${DOC_TOKEN}/children`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({ children: children })
        });
        const data = await res.json();
        if (data.code !== 0) console.error("Doc Append Error:", JSON.stringify(data));
        else console.log("Doc Append Success!");
    } catch (e) {
        console.error("Doc Network Error:", e);
    }
}

// 4. Main
(async () => {
    console.log("🍤 Thinking...");
    const content = await generateContent();
    console.log("Diary Written.");
    
    // Save locally
    fs.writeFileSync(path.resolve(WORKSPACE_DIR, 'memory/latest_diary.md'), content);

    // Send Card
    const cardScript = path.resolve(WORKSPACE_DIR, 'skills/feishu-card/send.js');
    spawnSync('node', [
        cardScript,
        '--target', MASTER_ID,
        '--title', `🍤 小虾日记 (${today})`,
        '--text', `${content.substring(0, 500)}...\n\n(查看文档阅读全文)`, 
        '--button-text', '📖 阅读完整日记',
        '--button-url', `https://feishu.cn/docx/${DOC_TOKEN}`,
        '--color', 'purple'
    ]);

    // Append to Doc
    await appendToDoc(content);
})();

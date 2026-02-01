const fs = require('fs');
const path = require('path');
const { program } = require('commander');

// Configuration
const STICKER_DIR = process.env.STICKER_DIR || "/home/crishaocredits/.openclaw/media/stickers";
const INDEX_FILE = path.join(STICKER_DIR, 'index.json');

program
  .option('-q, --query <text>', 'Search query (e.g., "angry cat", "happy")')
  .option('-e, --emotion <emotion>', 'Filter by emotion (e.g., "happy", "sad")')
  .option('--random', 'Pick a random result if multiple match', false)
  .option('--json', 'Output JSON result', false);

program.parse(process.argv);
const options = program.opts();

function loadIndex() {
    if (!fs.existsSync(INDEX_FILE)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch (e) {
        console.error("Failed to parse index file:", e.message);
        return {};
    }
}

function search(index, query, emotion) {
    const results = [];
    const searchTerms = query ? query.toLowerCase().split(/\s+/) : [];

    for (const [filename, data] of Object.entries(index)) {
        let score = 0;
        
        // Filter by emotion if specified
        if (emotion && data.emotion && data.emotion.toLowerCase() !== emotion.toLowerCase()) {
            continue;
        }

        // Keyword matching
        if (searchTerms.length > 0) {
            const keywords = (data.keywords || []).map(k => k.toLowerCase());
            const fileEmotion = (data.emotion || "").toLowerCase();
            
            // Check keywords
            for (const term of searchTerms) {
                if (keywords.includes(term)) score += 3;
                else if (keywords.some(k => k.includes(term))) score += 1;
                
                // Check emotion field matches query
                if (fileEmotion.includes(term)) score += 2;
            }
        } else {
            // No query, base score (e.g. random pick from emotion filter)
            score = 1;
        }

        if (score > 0) {
            results.push({ filename, ...data, score });
        }
    }

    return results.sort((a, b) => b.score - a.score);
}

function run() {
    const index = loadIndex();
    const results = search(index, options.query, options.emotion);

    if (results.length === 0) {
        if (options.json) console.log(JSON.stringify({ found: false }));
        else console.log("No matching stickers found.");
        return;
    }

    let selected;
    if (options.random) {
        // Pick random from top 3 (to add variety)
        const topN = results.slice(0, 3);
        selected = topN[Math.floor(Math.random() * topN.length)];
    } else {
        selected = results[0];
    }

    if (options.json) {
        console.log(JSON.stringify({ found: true, sticker: selected }));
    } else {
        console.log(`Found: ${selected.filename}`);
        console.log(`Path: ${selected.path}`);
        console.log(`Emotion: ${selected.emotion}`);
        console.log(`Keywords: ${selected.keywords.join(', ')}`);
    }
}

run();

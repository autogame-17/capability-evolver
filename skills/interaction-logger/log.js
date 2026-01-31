const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);

// Parse arguments: --target <user_alias> --role <user|assistant|system> --content <text>
function parseArgs(args) {
    const config = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const value = args[i + 1];
            config[key] = value;
            i++;
        }
    }
    return config;
}

const config = parseArgs(args);

if (!config.target || !config.content) {
    console.error("Usage: node log.js --target <zhy|fmw|auto> --role <role> --content <message>");
    process.exit(1);
}

// Map targets to files
const fileMap = {
    'zhy': 'zhy/history.json',
    'shiqi': 'zhy/history.json', // Alias
    'master': 'zhy/history.json', // Alias
    'fmw': 'fmw/history.json',
    'big-brother': 'fmw/history.json', // Alias
    'brother': 'fmw/history.json' // Alias
};

let filePath = fileMap[config.target.toLowerCase()];

// Auto-detect or fallback if target looks like a raw ID or unmapped name?
// For now, strict mapping to ensure we respect the folder structure.
if (!filePath) {
    // If not in map, maybe it's a direct filename? No, unsafe.
    // Default to a generic log if unknown?
    console.error(`Unknown target: ${config.target}. Allowed: zhy, fmw`);
    process.exit(1);
}

const absolutePath = path.resolve(process.cwd(), filePath);

// Ensure directory exists
const dir = path.dirname(absolutePath);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
}

// Read or Initialize
let data = { sessions: [] };
if (fs.existsSync(absolutePath)) {
    try {
        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        if (fileContent.trim()) {
            data = JSON.parse(fileContent);
        }
    } catch (e) {
        console.error("Error reading/parsing file:", e.message);
        // We do NOT overwrite corrupted files blindly.
        console.error("Aborting to prevent data loss.");
        process.exit(1);
    }
}

// Ensure schema
if (!data.sessions) {
    data.sessions = [];
}

// Create Entry
const entry = {
    timestamp: new Date().toISOString(),
    role: config.role || 'assistant',
    content: config.content
};

// Append
data.sessions.push(entry);

// Write Atomic-ish
try {
    fs.writeFileSync(absolutePath, JSON.stringify(data, null, 2));
    console.log(`Successfully logged to ${filePath}`);
} catch (e) {
    console.error("Error writing file:", e.message);
    process.exit(1);
}

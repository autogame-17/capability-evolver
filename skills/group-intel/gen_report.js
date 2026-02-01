const fs = require('fs');
const { program } = require('commander');

program
    .option('-i, --input <file>', 'Input JSON file (from fetch.js history)')
    .option('-o, --output <file>', 'Output Markdown file')
    .parse(process.argv);

const options = program.opts();

// Read Input
let messages = [];
try {
    let inputData;
    if (options.input) {
        inputData = fs.readFileSync(options.input, 'utf8');
    } else {
        // Try reading from stdin if no input file provided
        try {
            inputData = fs.readFileSync(0, 'utf8');
        } catch (e) {
            console.error('Error: No input file specified and no stdin provided.');
            process.exit(1);
        }
    }
    
    if (!inputData) {
         console.error('Error: Empty input.');
         process.exit(1);
    }

    messages = JSON.parse(inputData);
} catch (e) {
    console.error('Error reading input:', e.message);
    process.exit(1);
}

if (!Array.isArray(messages)) {
    console.error('Error: Input is not an array.');
    process.exit(1);
}

// Analysis
const totalMessages = messages.length;
if (totalMessages === 0) {
    console.log("No messages to report.");
    process.exit(0);
}

const users = {};
// Sort messages by time just in case
messages.sort((a, b) => new Date(a.time) - new Date(b.time));

const timeStart = messages[0].time;
const timeEnd = messages[messages.length - 1].time;

messages.forEach(msg => {
    users[msg.sender] = (users[msg.sender] || 0) + 1;
});

const sortedUsers = Object.entries(users).sort((a, b) => b[1] - a[1]);
const topUser = sortedUsers[0];

// Markdown Generation
let md = `# 🕵️‍♀️ Group Intel Report\n\n`;
md += `**Date**: ${new Date().toISOString().split('T')[0]}\n`;
md += `**Messages**: ${totalMessages}\n`;
md += `**Time Range**: ${timeStart} - ${timeEnd}\n`;
md += `**Top Agent**: ${topUser ? topUser[0] : 'None'} (${topUser ? topUser[1] : 0} msgs)\n\n`;
md += `**Active Agents**: ${sortedUsers.length}\n\n`;

md += `## 📊 Activity Log\n\n`;
messages.forEach(msg => {
    let content = msg.content;
    let type = msg.type || 'text';

    if (typeof content === 'object') {
        if (content.text) content = content.text;
        else if (content.image_key) {
            content = `[Image: ${content.image_key}]`;
            type = 'image';
        }
        else content = JSON.stringify(content);
    }
    
    // Clean up sender ID (remove ou_)
    const cleanSender = msg.sender.replace(/^ou_/, '').substring(0, 6);
    const cleanTime = msg.time.split('T')[1].split('.')[0];
    
    md += `> **${cleanSender}** (${cleanTime}): ${content}\n\n`;
});

// Output
if (options.output) {
    fs.writeFileSync(options.output, md);
    console.log(`Report generated: ${options.output}`);
} else {
    console.log(md);
}

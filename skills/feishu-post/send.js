#!/usr/bin/env node
const fs = require('fs');
const { program } = require('commander');
const path = require('path');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return res;
        } catch (e) {
            if (i === retries - 1) throw e;
            const delay = 1000 * Math.pow(2, i);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function getToken() {
    try {
        if (fs.existsSync(TOKEN_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (cached.expire > now + 60) return cached.token;
        }
    } catch (e) {}

    try {
        const res = await fetchWithRetry('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
        });
        const data = await res.json();
        if (!data.tenant_access_token) throw new Error(`No token returned: ${JSON.stringify(data)}`);

        try {
            const cacheData = {
                token: data.tenant_access_token,
                expire: Math.floor(Date.now() / 1000) + data.expire 
            };
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        } catch (e) {
            console.error('Failed to cache token:', e.message);
        }

        return data.tenant_access_token;
    } catch (e) {
        console.error('Failed to get token:', e.message);
        process.exit(1);
    }
}

function parseMarkdownToRichText(md) {
    // Basic Markdown Parser for Feishu Post (Richtext)
    // Supports:
    // - Headers (#) -> title (handled separately or just bold)
    // - Bold (**text**)
    // - Italic (*text*)
    // - Code blocks (```lang ... ```)
    // - Inline code (`text`)
    // - Links ([text](url))
    // - Lists (- item) (Approximated)
    // - Images (![alt](key))
    
    // Feishu Post Structure: [[{ tag: "text", text: "..." }, ...], ...] (Array of paragraphs)
    
    const lines = md.split('\n');
    const content = [];
    let inCodeBlock = false;
    let codeBlockBuffer = [];

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            if (inCodeBlock) {
                // End code block
                inCodeBlock = false;
                // Add code block element (Feishu doesn't have native code block in Post? Wait, it does)
                // Post schema: text, a, at, img, media
                // It does NOT have 'code_block' in standard post. Only in Doc or Card.
                // Fallback: Use text with monospaced style if possible, or just raw text.
                // Actually, rich text message (post) supports limited tags.
                // Best fallback for code block in Post: just text.
                content.push([{ tag: 'text', text: codeBlockBuffer.join('\n') }]);
                codeBlockBuffer = [];
            } else {
                inCodeBlock = true;
                // Check if language specified
                // const lang = line.trim().substring(3);
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockBuffer.push(line);
            continue;
        }

        // Process line for inline formatting
        const elements = processInlineFormatting(line);
        if (elements.length > 0) {
            content.push(elements);
        } else {
            // Empty line -> empty text to create spacing
            content.push([{ tag: 'text', text: '' }]);
        }
    }
    
    return content;
}

function processInlineFormatting(line) {
    // 1. Header parsing (Convert to bold text)
    let text = line;
    let styles = [];
    if (text.startsWith('#')) {
        text = text.replace(/^#+\s*/, '');
        styles.push('bold');
    }

    // 2. Tokenize for Bold, Italic, Link
    // Simple state machine or multiple regex passes?
    // Regex split approach is safer for simple nesting.
    
    // Pattern: Links [text](url) OR Bold **text** OR Italic *text*
    // We split by a regex that captures all delimiters
    const regex = /(\*\*.+?\*\*)|(\*.+?\*)|(\[.+?\]\(.+?\))/g;
    
    const parts = text.split(regex).filter(p => p !== undefined && p !== '');
    const elements = [];

    // If split failed to separate (no matches), parts is just [text]
    // Wait, split with capturing groups includes the captures. 
    // Example: "A **B** C".split(/(\*\*.*?\*\*)/) -> ["A ", "**B**", " C"]
    
    // We need to re-verify what the captures are.
    // If we use multiple groups, they all appear.
    // Let's iterate manually to identify type.

    let currentIndex = 0;
    // We need to handle the original string to preserve order.
    // Let's use matchAll or exec in a loop.
    
    const tokenRegex = /(\*\*(?<bold>.+?)\*\*)|(\*(?<italic>.+?)\*)|(\[(?<linkText>.+?)\]\((?<linkUrl>.+?)\))/g;
    
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
        // Add preceding text
        if (match.index > currentIndex) {
            elements.push({ 
                tag: 'text', 
                text: text.substring(currentIndex, match.index),
                style: [...styles]
            });
        }

        if (match.groups.bold) {
            elements.push({
                tag: 'text',
                text: match.groups.bold,
                style: [...styles, 'bold']
            });
        } else if (match.groups.italic) {
            elements.push({
                tag: 'text',
                text: match.groups.italic,
                style: [...styles, 'italic']
            });
        } else if (match.groups.linkText) {
            elements.push({
                tag: 'a',
                text: match.groups.linkText,
                href: match.groups.linkUrl,
                style: [...styles]
            });
        }

        currentIndex = tokenRegex.lastIndex;
    }

    // Add remaining text
    if (currentIndex < text.length) {
        elements.push({ 
            tag: 'text', 
            text: text.substring(currentIndex),
            style: [...styles]
        });
    }

    return elements;
}

async function sendPost(options) {
    const token = await getToken();
    
    let contentText = '';
    if (options.textFile) {
        try { contentText = fs.readFileSync(options.textFile, 'utf8'); } catch (e) {
            console.error(`Failed to read file: ${options.textFile}`);
            process.exit(1);
        }
    } else if (options.text) {
        contentText = options.text.replace(/\\n/g, '\n');
    }

    if (!contentText) {
        console.error('No content to send.');
        process.exit(1);
    }

    // Convert MD to Feishu Post structure
    const postContent = parseMarkdownToRichText(contentText);
    
    const postObj = {
        zh_cn: {
            title: options.title || '',
            content: postContent
        }
    };

    let receiveIdType = 'open_id';
    if (options.target.startsWith('oc_')) receiveIdType = 'chat_id';
    else if (options.target.startsWith('ou_')) receiveIdType = 'open_id';
    else if (options.target.includes('@')) receiveIdType = 'email';

    const messageBody = {
        receive_id: options.target,
        msg_type: 'post',
        content: JSON.stringify(postObj)
    };

    console.log(`Sending Post (RichText) to ${options.target}...`);

    try {
        const res = await fetchWithRetry(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(messageBody)
            }
        );
        const data = await res.json();
        
        if (data.code !== 0) {
             throw new Error(`API Error ${data.code}: ${data.msg}`);
        }
        
        console.log('Success:', JSON.stringify(data.data, null, 2));

    } catch (e) {
        console.error('Post Send Failed:', e.message);
        process.exit(1);
    }
}

program
  .requiredOption('-t, --target <id>', 'Target ID')
  .option('-x, --text <markdown>', 'Post content')
  .option('-f, --text-file <path>', 'Post content file')
  .option('--title <text>', 'Post title');

program.parse(process.argv);
const options = program.opts();

(async () => {
    sendPost(options);
})();

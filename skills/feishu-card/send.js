const fs = require('fs');
const { program } = require('commander');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); // Load workspace .env

// Credentials from environment
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');
const IMAGE_KEY_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_image_keys.json');
const STATS_FILE = path.resolve(__dirname, '../../memory/feishu_card_stats.json');

// Helper: Update Telemetry Stats
function updateStats(type, details = null) {
    try {
        let stats = { total_sent: 0, success_card: 0, success_fallback: 0, failed: 0, last_updated: 0 };
        if (fs.existsSync(STATS_FILE)) {
            try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) {}
        }
        
        stats.total_sent++;
        stats.last_updated = Date.now();

        if (type === 'card_success') stats.success_card++;
        if (type === 'fallback_success') {
            stats.success_fallback++;
            stats.last_fallback_reason = details;
            stats.last_fallback_time = Date.now();
        }
        if (type === 'failure') {
            stats.failed++;
            stats.last_failure = details;
            stats.last_failure_time = Date.now();
        }

        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        // Silently fail on stats to not break main flow
    }
}

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

// Helper: Fetch with smart retry (retries only on network/server errors)
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            
            // Success: 2xx
            if (res.ok) return res;

            // Client Error (4xx): Do NOT retry (except 429)
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                // Return response immediately so caller can handle the error logic (e.g. read body)
                // or throw immediately to trigger fallback if that's the strategy.
                // In this script, we usually want to throw so sendCard catches it.
                throw new Error(`HTTP ${res.status} ${res.statusText} (Client Error - No Retry)`);
            }

            // Server Error (5xx) or Rate Limit (429): Retry
            throw new Error(`HTTP ${res.status} ${res.statusText}`);

        } catch (e) {
            // Don't retry if we explicitly said "No Retry" (Client Error)
            if (e.message.includes('(Client Error - No Retry)')) {
                throw e;
            }

            if (i === retries - 1) throw e;
            
            const delay = 1000 * Math.pow(2, i); // 1s, 2s, 4s
            console.warn(`[Fetch] Attempt ${i+1}/${retries} failed: ${e.message}. Retrying in ${delay}ms...`);
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

async function uploadImage(token, filePath) {
    let fileHash;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    } catch (e) {
        console.error('Error reading image file:', e.message);
        throw e;
    }

    let cache = {};
    if (fs.existsSync(IMAGE_KEY_CACHE_FILE)) {
        try { cache = JSON.parse(fs.readFileSync(IMAGE_KEY_CACHE_FILE, 'utf8')); } catch (e) {}
    }
    
    if (cache[fileHash]) {
        console.log(`Using cached image key (Hash: ${fileHash.substring(0,8)})`);
        return cache[fileHash];
    }

    console.log(`Uploading image (Hash: ${fileHash.substring(0,8)})...`);
    
    const formData = new FormData();
    formData.append('image_type', 'message');
    const fileContent = fs.readFileSync(filePath);
    const blob = new Blob([fileContent]); 
    formData.append('image', blob, path.basename(filePath));

    try {
        const res = await fetchWithRetry('https://open.feishu.cn/open-apis/im/v1/images', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        
        if (data.code !== 0) throw new Error(JSON.stringify(data));
        
        const imageKey = data.data.image_key;
        cache[fileHash] = imageKey;
        try { fs.writeFileSync(IMAGE_KEY_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch(e) {}
        
        return imageKey;
    } catch (e) {
        console.error('Image upload failed:', e.message);
        throw e;
    }
}

function buildCardContent(elements, title, color) {
    const card = {
        config: {
            wide_screen_mode: true
        },
        elements: elements
    };

    if (title) {
        card.header = {
            title: { tag: 'plain_text', content: title },
            template: color || 'blue'
        };
    }
    return card;
}

async function sendCard(options) {
    const token = await getToken();
    const elements = [];
    
    if (options.imagePath) {
        try {
            const imageKey = await uploadImage(token, options.imagePath);
            elements.push({
                tag: 'img',
                img_key: imageKey,
                alt: { tag: 'plain_text', content: options.imageAlt || 'Image' },
                mode: 'fit_horizontal'
            });
        } catch (e) {
            console.warn(`[Feishu-Card] Warning: Skipping image "${options.imagePath}" due to upload failure: ${e.message}`);
            // Proceed without image
        }
    }

    let contentText = '';
    if (options.textFile) {
        try { contentText = fs.readFileSync(options.textFile, 'utf8'); } catch (e) {
            console.error(`Failed to read file: ${options.textFile}`);
            process.exit(1);
        }
    } else if (options.text) {
        contentText = options.text.replace(/\\n/g, '\n');
    }

    if (contentText) {
        // Safety: Truncate to avoid API limits (Feishu Card limit ~30k chars)
        const MAX_CHARS = 25000;
        if (contentText.length > MAX_CHARS) {
            console.warn(`[Feishu-Card] Content too long (${contentText.length} chars). Truncating to ${MAX_CHARS}.`);
            contentText = contentText.substring(0, MAX_CHARS) + '\n\n...(Output Truncated due to size limit)...';
        }

        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: contentText
            }
        });
    }

    if (options.buttonText && options.buttonUrl) {
        elements.push({
            tag: 'action',
            actions: [{
                tag: 'button',
                text: { tag: 'plain_text', content: options.buttonText },
                type: 'primary',
                multi_url: { url: options.buttonUrl, pc_url: '', android_url: '', ios_url: '' }
            }]
        });
    }

    const cardObj = buildCardContent(elements, options.title, options.color);
    
    let receiveIdType = 'open_id';
    if (options.target.startsWith('oc_')) receiveIdType = 'chat_id';
    else if (options.target.startsWith('ou_')) receiveIdType = 'open_id';
    else if (options.target.includes('@')) receiveIdType = 'email';

    const messageBody = {
        receive_id: options.target,
        msg_type: 'interactive',
        content: JSON.stringify(cardObj)
    };

    console.log(`Sending card to ${options.target} (Elements: ${elements.length})`);

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
             console.warn(`[Feishu-Card] Card send failed (Code: ${data.code}, Msg: ${data.msg}). Attempting fallback to plain text...`);
             return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title, `Card Error: ${data.msg}`);
        }
        
        console.log('Success:', JSON.stringify(data.data, null, 2));
        updateStats('card_success');

    } catch (e) {
        console.error('Network/API Error during Card Send:', e.message);
        console.log('[Feishu-Card] Attempting fallback to plain text...');
        return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title, `Network Error: ${e.message}`);
    }
}

async function sendPlainTextFallback(token, receiveIdType, receiveId, text, title, reason = 'Unknown') {
    if (!text) {
        console.error('Fallback failed: No text content available.');
        process.exit(1);
    }

    let finalContent = text;
    if (title) finalContent = `【${title}】\n\n${text}`;

    const messageBody = {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: finalContent })
    };

    console.log(`Sending Fallback Text to ${receiveId}...`);

    try {
        const res = await fetchWithRetry(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(messageBody)
            }
        );
        const data = await res.json();
        if (data.code !== 0) {
             console.error('Fallback Text Send Failed:', JSON.stringify(data, null, 2));
             updateStats('failure', `Fallback Failed: ${data.msg} (Original: ${reason})`);
             process.exit(1);
        }
        console.log('Fallback Success:', JSON.stringify(data.data, null, 2));
        updateStats('fallback_success', reason);
    } catch (e) {
        console.error('Fallback Network Error:', e.message);
        updateStats('failure', `Fallback Network Error: ${e.message} (Original: ${reason})`);
        process.exit(1);
    }
}

program
  .option('-t, --target <open_id>', 'Target User Open ID (Auto-detected if omitted)')
  .option('-x, --text <markdown>', 'Card body text (Markdown)')
  .option('-f, --text-file <path>', 'Read card body text from file')
  .option('--title <text>', 'Card header title')
  .option('--color <color>', 'Header color (blue/red/orange/purple/etc)', 'blue')
  .option('--button-text <text>', 'Bottom button text')
  .option('--button-url <url>', 'Bottom button URL')
  .option('--text-size <size>', 'Text size')
  .option('--text-align <align>', 'Text alignment')
  .option('--image-path <path>', 'Path to local image to embed')
  .option('--image-alt <text>', 'Alt text for image');

program.parse(process.argv);
const options = program.opts();

// Helper: Auto-detect target
function getAutoTarget() {
    // 1. Explicitly provided via CLI (already handled, but checked here for clarity)
    if (options.target) return options.target;

    // 2. Environment Variable (Priority)
    if (process.env.FEISHU_TARGET_ID) return process.env.FEISHU_TARGET_ID;

    // 3. Shared Context File (New Standard)
    try {
        const contextPath = path.resolve(__dirname, '../../memory/context.json');
        if (fs.existsSync(contextPath)) {
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            if (context.last_active_user) return context.last_active_user;
            if (context.last_active_chat) return context.last_active_chat;
        }
    } catch (e) {}

    // 4. Menu Events Log (Fallback to last interactor)
    try {
        const menuPath = path.resolve(__dirname, '../../memory/menu_events.json');
        if (fs.existsSync(menuPath)) {
            const events = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
            if (Array.isArray(events) && events.length > 0) {
                const lastEvent = events[events.length - 1];
                // Check raw structure first for most detail
                if (lastEvent.raw && lastEvent.raw.event && lastEvent.raw.event.operator && lastEvent.raw.event.operator.operator_id) {
                     return lastEvent.raw.event.operator.operator_id.open_id;
                }
                if (lastEvent.userId && lastEvent.userId !== 'unknown') return lastEvent.userId;
            }
        }
    } catch (e) {}
    
    // 5. Master ID (Last Resort)
    if (process.env.MASTER_ID) return process.env.MASTER_ID;

    return null;
}

async function readStdin() {
    const { stdin } = process;
    if (stdin.isTTY) return '';
    stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data;
}

(async () => {
    let textContent = options.text;
    if (options.textFile) {
        // handled in sendCard
    } else if (!textContent) {
        try {
             const stdinText = await readStdin();
             if (stdinText.trim()) options.text = stdinText;
        } catch (e) {}
    }

    if (!options.text && !options.textFile && !options.imagePath) {
        console.error('Error: No content provided.');
        process.exit(1);
    }

    // Auto-detect target if not provided
    if (!options.target) {
        const autoTarget = getAutoTarget();
        if (autoTarget) {
            console.log(`[Feishu-Card] Auto-detected target: ${autoTarget}`);
            options.target = autoTarget;
        } else {
            console.error('Error: Target not specified and could not be auto-detected.');
            console.error('  - Provide via -t/--target');
            console.error('  - Set FEISHU_TARGET_ID env var');
            console.error('  - Or ensure memory/context.json exists');
            process.exit(1);
        }
    }

    sendCard(options);
})();

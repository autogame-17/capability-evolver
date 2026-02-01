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

// Helper: Atomic JSON Write (prevents partial writes/corruption)
function writeJsonAtomic(filePath, data) {
    try {
        const tempPath = `${filePath}.tmp.${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, filePath); // Atomic on POSIX
    } catch (e) {
        console.error(`[Feishu-Card] Failed to write atomic JSON to ${filePath}: ${e.message}`);
        // Attempt cleanup
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (delErr) {}
    }
}

// Helper: Update Telemetry Stats
function updateStats(type, details = null) {
    try {
        let stats = { total_sent: 0, success_card: 0, success_fallback: 0, failed: 0, last_updated: 0 };
        if (fs.existsSync(STATS_FILE)) {
            try { 
                const raw = fs.readFileSync(STATS_FILE, 'utf8');
                if (raw.trim()) stats = JSON.parse(raw); 
            } catch (e) {
                console.warn(`[Feishu-Card] Warning: Corrupted stats file. Backing up to .corrupt`);
                try { fs.copyFileSync(STATS_FILE, `${STATS_FILE}.corrupt`); } catch (err) {}
                // Keep default stats (zeros) to reset, but at least we saved the old data
            }
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

        writeJsonAtomic(STATS_FILE, stats);
    } catch (e) {
        // Silently fail on stats to not break main flow
    }
}

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

// Helper: Fetch with smart retry (retries only on network/server errors)
async function fetchWithRetry(url, options, retries = 3, timeoutMs = 15000) {
    for (let i = 0; i < retries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const fetchOptions = { ...options, signal: controller.signal };

        try {
            const res = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);
            
            // Success: 2xx
            if (res.ok) return res;

            // Handle Rate Limiting (429) specifically
            if (res.status === 429) {
                const retryAfter = res.headers.get('retry-after');
                const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, i);
                console.warn(`[Fetch] Rate Limited (429). Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue; // Retry immediately after wait
            }

            // Client Error (4xx): Do NOT retry (except 429)
            if (res.status >= 400 && res.status < 500) {
                const requestId = res.headers.get('x-request-id') || 'unknown';
                // Read body for error details
                let errBody = '';
                try { errBody = await res.text(); } catch(e) {}
                
                throw new Error(`HTTP ${res.status} ${res.statusText} (ReqID: ${requestId}) - ${errBody}`);
            }

            // Server Error (5xx): Retry
            throw new Error(`HTTP ${res.status} ${res.statusText}`);

        } catch (e) {
            clearTimeout(timeoutId);
            
            if (e.name === 'AbortError') {
                e.message = `Request timed out after ${timeoutMs}ms`;
            }

            // Don't retry if we explicitly said "No Retry" (Client Error)
            // or if we already handled 429 logic above
            if (e.message.includes('(ReqID:')) {
                throw e;
            }

            if (i === retries - 1) throw e;
            
            // Exponential Backoff with Jitter
            const baseDelay = 1000 * Math.pow(2, i);
            const jitter = Math.random() * 500; // 0-500ms jitter
            const delay = baseDelay + jitter;
            
            console.warn(`[Fetch] Attempt ${i+1}/${retries} failed: ${e.message}. Retrying in ${Math.floor(delay)}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function getToken(forceRefresh = false) {
    try {
        if (!forceRefresh && fs.existsSync(TOKEN_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (cached.expire > now + 300) return cached.token; // Buffer increased to 5 mins
        }
    } catch (e) {}

    if (forceRefresh) {
        console.log('[Feishu-Card] Forcing token refresh...');
        try { if (fs.existsSync(TOKEN_CACHE_FILE)) fs.unlinkSync(TOKEN_CACHE_FILE); } catch(e) {}
    }

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
            writeJsonAtomic(TOKEN_CACHE_FILE, cacheData);
        } catch (e) {
            console.error('Failed to cache token:', e.message);
        }

        return data.tenant_access_token;
    } catch (e) {
        console.error('Failed to get token:', e.message);
        process.exit(1);
    }
}

// Helper: Execute an operation with token retry on Auth failure
async function executeWithAuthRetry(operation) {
    let token = await getToken();
    try {
        return await operation(token);
    } catch (e) {
        // Feishu Auth Errors: 99991663 (Tenant Token Invalid), 99991661 (Token Expired), etc.
        const msg = e.message || '';
        const isAuthError = msg.includes('9999166') || 
                           (msg.toLowerCase().includes('token') && (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expire')));
        
        if (isAuthError) {
            console.warn(`[Feishu-Card] Auth Error detected (${msg}). Refreshing token and retrying...`);
            token = await getToken(true); // Force refresh
            return await operation(token);
        }
        throw e;
    }
}

async function uploadImage(token, filePath) {
    let fileBuffer;
    let fileHash;
    
    try {
        fileBuffer = fs.readFileSync(filePath);
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
    // Reuse the buffer we already read
    const blob = new Blob([fileBuffer]); 
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
        try { writeJsonAtomic(IMAGE_KEY_CACHE_FILE, cache); } catch(e) {}
        
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

async function sendCardLogic(token, options) {
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

    let contentText = options.text || '';

    if (contentText) {
        // Safety: Truncate to avoid API limits (Feishu Card limit ~30k chars)
        const MAX_CHARS = 25000;
        if (contentText.length > MAX_CHARS) {
            const overflowDir = path.resolve(__dirname, '../../memory/logs');
            try {
                if (!fs.existsSync(overflowDir)) fs.mkdirSync(overflowDir, { recursive: true });
                const overflowFile = path.join(overflowDir, `overflow_${Date.now()}.txt`);
                fs.writeFileSync(overflowFile, contentText);
                console.warn(`[Feishu-Card] Content too long (${contentText.length} chars). Truncating to ${MAX_CHARS}. Full content saved to ${overflowFile}`);
                contentText = contentText.substring(0, MAX_CHARS) + `\n\n⚠️ **Output Truncated** (Size Limit). Full content saved locally to:\n\`${overflowFile}\``;
            } catch (e) {
                console.error(`[Feishu-Card] Failed to save overflow content: ${e.message}`);
                contentText = contentText.substring(0, MAX_CHARS) + '\n\n...(Output Truncated due to size limit)...';
            }
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
             // Check for Auth Error codes
             if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                 throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
             }

             console.warn(`[Feishu-Card] Card send failed (Code: ${data.code}, Msg: ${data.msg}). Attempting fallback to plain text...`);
             return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title, `Card Error: ${data.msg}`);
        }
        
        console.log('Success:', JSON.stringify(data.data, null, 2));
        updateStats('card_success');

    } catch (e) {
        // Rethrow Auth Errors to trigger refresh
        const msg = e.message || '';
        if (msg.includes('9999166') || (msg.toLowerCase().includes('token') && (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expire')))) {
             throw e;
        }

        console.error('Network/API Error during Card Send:', e.message);
        console.log('[Feishu-Card] Attempting fallback to plain text...');
        return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title, `Network Error: ${e.message}`);
    }
}

async function sendCard(options) {
    return executeWithAuthRetry(async (token) => {
        return await sendCardLogic(token, options);
    });
}

async function sendPlainTextFallback(token, receiveIdType, receiveId, text, title, reason = 'Unknown') {
    if (!text) {
        console.error('Fallback failed: No text content available.');
        process.exit(1);
    }

    let finalContent = text;
    if (title) finalContent = `【${title}】\n\n${text}`;

    // Safety: Truncate to avoid API limits (Feishu Text limit ~30k chars)
    const MAX_CHARS = 28000;
    if (finalContent.length > MAX_CHARS) {
        const overflowDir = path.resolve(__dirname, '../../memory/logs');
        try {
            if (!fs.existsSync(overflowDir)) fs.mkdirSync(overflowDir, { recursive: true });
            const overflowFile = path.join(overflowDir, `overflow_fallback_${Date.now()}.txt`);
            fs.writeFileSync(overflowFile, finalContent);
            console.warn(`[Feishu-Card] Fallback text too long (${finalContent.length} chars). Truncating. Full content saved to ${overflowFile}`);
            finalContent = finalContent.substring(0, MAX_CHARS) + `\n\n⚠️ **Output Truncated** (Size Limit). Full content saved locally to:\n\`${overflowFile}\``;
        } catch (e) {
            console.error(`[Feishu-Card] Failed to save overflow content: ${e.message}`);
            finalContent = finalContent.substring(0, MAX_CHARS) + '\n\n...(Fallback Output Truncated)...';
        }
    }

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
            
            // Priority: Group Chat (oc_) > User (ou_)
            // If we are in a group context, we should reply to the group.
            if (context.last_active_chat && context.last_active_chat.startsWith('oc_')) {
                console.log(`[Feishu-Card] Target Source: context.json (Group: ${context.last_active_chat})`);
                return context.last_active_chat;
            }
            
            if (context.last_active_user) {
                console.log(`[Feishu-Card] Target Source: context.json (User: ${context.last_active_user})`);
                return context.last_active_user;
            }

            if (context.last_active_chat) {
                console.log(`[Feishu-Card] Target Source: context.json (Chat: ${context.last_active_chat})`);
                return context.last_active_chat;
            }
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
    
    // 5. Parse USER.md for Master ID (Robust Fallback)
    try {
        const userMdPath = path.resolve(__dirname, '../../USER.md');
        if (fs.existsSync(userMdPath)) {
            const userMd = fs.readFileSync(userMdPath, 'utf8');
            // Regex to find "Feishu ID: `ou_...`" under "Owner" or "Master" section
            // Simple approach: Look for "Master" or "Owner" then the next Feishu ID
            const masterMatch = userMd.match(/(?:Master|Owner).*?Feishu ID:.*?`(ou_[a-z0-9]+)`/s);
            if (masterMatch && masterMatch[1]) {
                console.log(`[Feishu-Card] Target Source: USER.md (Master: ${masterMatch[1]})`);
                return masterMatch[1];
            }
            // Fallback: Just find the first "ou_" ID in the file if specific Master tag fails
            const firstOu = userMd.match(/`(ou_[a-z0-9]+)`/);
            if (firstOu && firstOu[1]) {
                 console.log(`[Feishu-Card] Target Source: USER.md (First Found: ${firstOu[1]})`);
                 return firstOu[1];
            }
        }
    } catch (e) {}
    
    // 6. Master ID (Env Fallback)
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

const ALLOWED_COLORS = [
    'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 
    'red', 'carmine', 'violet', 'purple', 'indigo', 'grey'
];

(async () => {
    // Phase 1: Input Normalization
    let fromCli = false;
    if (options.text) fromCli = true; // Was provided via -x flag

    if (options.textFile) {
        try {
            options.text = fs.readFileSync(options.textFile, 'utf8');
            delete options.textFile; // Consumed
        } catch (e) {
            console.error(`Failed to read file: ${options.textFile}`);
            process.exit(1);
        }
    } else if (!options.text) {
        try {
             const stdinText = await readStdin();
             if (stdinText.trim()) options.text = stdinText;
        } catch (e) {}
    }

    if (!options.text && !options.imagePath) {
        console.error('Error: No content provided.');
        process.exit(1);
    }

    // Unescape newlines only if originally from CLI arg
    if (fromCli && options.text) {
        options.text = options.text.replace(/\\n/g, '\n');
    }

    // Phase 2: Feature Extraction (Auto-Title)
    if (!options.title && options.text) {
        const titleRegexes = [
            /^#\s+(.+)(\r?\n|$)/,          // # Title
            /^\*\*(.+)\*\*(\r?\n|$)/,      // **Title**
            /^【(.+)】(\r?\n|$)/            // 【Title】
        ];

        for (const regex of titleRegexes) {
            const match = options.text.match(regex);
            if (match && match[1]) {
                options.title = match[1].trim();
                options.text = options.text.substring(match[0].length).trim();
                console.log(`[Feishu-Card] Auto-extracted title: "${options.title}"`);
                break;
            }
        }
    }

    // Validation: Check Color
    if (options.color && !ALLOWED_COLORS.includes(options.color)) {
        console.warn(`[Feishu-Card] Warning: Invalid color '${options.color}'. Allowed: ${ALLOWED_COLORS.join(', ')}.`);
        console.warn(`[Feishu-Card] Falling back to 'blue'.`);
        options.color = 'blue';
    }

    // Optimization: Auto-Color Logic based on content semantics
    // Only apply if user didn't manually override the default 'blue'
    if (options.color === 'blue') {
        const titleUpper = (options.title || '').toUpperCase();
        
        // Priority 1: Title Checks (Strong Signal)
        if (titleUpper.includes('EVOLUTION') && titleUpper.includes('CYCLE')) options.color = 'purple';
        else if (titleUpper.includes('OPTIMIZATION') || titleUpper.includes('UPGRADE')) options.color = 'violet';
        else if (titleUpper.includes('FAILED') || titleUpper.includes('ERROR') || titleUpper.includes('CRITICAL')) options.color = 'red';
        else if (titleUpper.includes('WARNING') || titleUpper.includes('ALERT')) options.color = 'orange';
        else if (titleUpper.includes('SUCCESS') || titleUpper.includes('RESOLVED')) options.color = 'green';

        // Priority 2: Body Checks (Only if Title didn't decide)
        if (options.color === 'blue') {
            let bodyText = options.text || '';
            if (options.textFile) {
                try { bodyText += fs.readFileSync(options.textFile, 'utf8'); } catch(e) {}
            }
            const bodyUpper = bodyText.toUpperCase();
            
            // Order by Severity (High to Low)
            if (bodyUpper.includes('FAILED') || bodyUpper.includes('ERROR') || bodyUpper.includes('CRITICAL')) options.color = 'red';
            else if (bodyUpper.includes('WARNING') || bodyUpper.includes('ALERT')) options.color = 'orange';
            else if (bodyUpper.includes('SUCCESS') || bodyUpper.includes('RESOLVED')) options.color = 'green';
            // Persona Alignment: Auto-carmine for affectionate content
            else if (bodyUpper.includes('LOVE') || bodyUpper.includes('MASTER') || bodyUpper.includes('MEOW') || bodyUpper.includes('❤') || bodyUpper.includes('❤️')) options.color = 'carmine';
        }

        if (options.color !== 'blue') console.log(`[Feishu-Card] Auto-set color to ${options.color} based on content.`);
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

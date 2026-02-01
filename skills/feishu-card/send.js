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

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

// Helper: Fetch with exponential backoff retry
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return res;
        } catch (e) {
            if (i === retries - 1) throw e;
            const delay = 1000 * Math.pow(2, i); // 1s, 2s, 4s
            console.warn(`Fetch failed (${e.message}). Retrying in ${delay}ms...`);
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
        process.exit(1);
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
        process.exit(1);
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
        const imageKey = await uploadImage(token, options.imagePath);
        elements.push({
            tag: 'img',
            img_key: imageKey,
            alt: { tag: 'plain_text', content: options.imageAlt || 'Image' },
            mode: 'fit_horizontal'
        });
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
             return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title);
        }
        
        console.log('Success:', JSON.stringify(data.data, null, 2));

    } catch (e) {
        console.error('Network/API Error during Card Send:', e.message);
        console.log('[Feishu-Card] Attempting fallback to plain text...');
        return await sendPlainTextFallback(token, receiveIdType, options.target, contentText, options.title);
    }
}

async function sendPlainTextFallback(token, receiveIdType, receiveId, text, title) {
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
             process.exit(1);
        }
        console.log('Fallback Success:', JSON.stringify(data.data, null, 2));
    } catch (e) {
        console.error('Fallback Network Error:', e.message);
        process.exit(1);
    }
}

program
  .requiredOption('-t, --target <open_id>', 'Target User Open ID')
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

    sendCard(options);
})();

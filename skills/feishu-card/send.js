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

async function getToken() {
    // 1. Try to read from cache
    try {
        if (fs.existsSync(TOKEN_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (cached.expire > now + 60) { // Buffer of 60 seconds
                // console.log('Using cached token');
                return cached.token;
            }
        }
    } catch (e) {
        // Ignore cache read errors
    }

    // 2. Fetch new token
    try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                app_id: APP_ID,
                app_secret: APP_SECRET
            })
        });
        const data = await res.json();
        if (!data.tenant_access_token) {
            throw new Error(`No token returned: ${JSON.stringify(data)}`);
        }

        // 3. Save to cache
        try {
            const cacheData = {
                token: data.tenant_access_token,
                expire: Math.floor(Date.now() / 1000) + data.expire // data.expire is usually seconds duration
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
    // Calculate hash for caching
    let fileHash;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    } catch (e) {
        console.error('Error reading image file:', e.message);
        process.exit(1);
    }

    // Check Cache
    let cache = {};
    if (fs.existsSync(IMAGE_KEY_CACHE_FILE)) {
        try { cache = JSON.parse(fs.readFileSync(IMAGE_KEY_CACHE_FILE, 'utf8')); } catch (e) {}
    }
    
    if (cache[fileHash]) {
        console.log(`Using cached image key (Hash: ${fileHash.substring(0,8)})`);
        return cache[fileHash];
    }

    // Upload
    console.log(`Uploading image (Hash: ${fileHash.substring(0,8)})...`);
    
    const formData = new FormData();
    formData.append('image_type', 'message');
    // Read entire file into Blob.
    const fileContent = fs.readFileSync(filePath);
    const blob = new Blob([fileContent]); 
    formData.append('image', blob, path.basename(filePath));

    try {
        const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
                // Content-Type header is automatically set by FormData with boundary
            },
            body: formData
        });
        const data = await res.json();
        
        if (data.code !== 0) {
            throw new Error(JSON.stringify(data));
        }
        
        const imageKey = data.data.image_key;
        
        // Update Cache
        cache[fileHash] = imageKey;
        try { fs.writeFileSync(IMAGE_KEY_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch(e) {}
        
        return imageKey;
    } catch (e) {
        console.error('Image upload failed:', e.message);
        process.exit(1);
    }
}

async function sendCard(options) {
    const token = await getToken();
    
    // Construct Card Elements
    const elements = [];
    
    // 1. Image (Top priority if desired, or we can make order configurable. For now: Top)
    if (options.imagePath) {
        const imageKey = await uploadImage(token, options.imagePath);
        elements.push({
            tag: 'img',
            img_key: imageKey,
            alt: {
                tag: 'plain_text',
                content: options.imageAlt || 'Image'
            },
            mode: 'fit_horizontal' // fit_horizontal, crop_center
        });
    }

    let contentText = '';

    if (options.textFile) {
        try {
            contentText = fs.readFileSync(options.textFile, 'utf8');
        } catch (e) {
            console.error(`Failed to read file: ${options.textFile}`);
            process.exit(1);
        }
    } else if (options.text) {
        // Fix newline and escaped newline issues from CLI arguments
        contentText = options.text.replace(/\\n/g, '\n');
    }

    if (contentText) {
        // Use the 'markdown' tag directly for better rendering support (code blocks, tables, etc.)
        // Ref: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/rich-text
        const markdownElement = {
            tag: 'markdown',
            content: contentText
        };
        
        if (options.textSize) {
            markdownElement.text_size = options.textSize;
        }
        
        if (options.textAlign) {
            markdownElement.text_align = options.textAlign;
        }

        elements.push(markdownElement);
    }

    // Add Button if provided
    if (options.buttonText && options.buttonUrl) {
        elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: {
                        tag: 'plain_text',
                        content: options.buttonText
                    },
                    type: 'primary',
                    multi_url: {
                        url: options.buttonUrl,
                        pc_url: '',
                        android_url: '',
                        ios_url: ''
                    }
                }
            ]
        });
    }

    // Construct Card Object
    const cardContent = { elements };

    // Add Header if title is provided
    if (options.title) {
        cardContent.header = {
            title: {
                tag: 'plain_text',
                content: options.title
            },
            template: options.color || 'blue' // blue, wathet, turquoise, green, yellow, orange, red, carmine, violet, purple, indigo, grey
        };
    }

    // Interactive Message Body
    const messageBody = {
        receive_id: options.target,
        msg_type: 'interactive',
        content: JSON.stringify(cardContent)
    };

    // Log summary instead of full payload to reduce noise and protect privacy
    console.log(`Sending card to ${options.target} (Type: ${messageBody.msg_type}, Elements: ${elements.length})`);

    // Determine target type (default to open_id)
    let receiveIdType = 'open_id';
    if (options.target.startsWith('oc_')) {
        receiveIdType = 'chat_id';
    } else if (options.target.startsWith('ou_')) {
        receiveIdType = 'open_id';
    } else if (options.target.includes('@')) {
        receiveIdType = 'email';
    }

    // console.log(`Sending to ${options.target} (${receiveIdType})`);

    try {
        const res = await fetch(
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
             console.error('Feishu API Error:', JSON.stringify(data, null, 2));
             process.exit(1);
        }
        
        console.log('Success:', JSON.stringify(data.data, null, 2));

    } catch (e) {
        console.error('Network Error:', e.message);
        process.exit(1);
    }
}

program
  .requiredOption('-t, --target <open_id>', 'Target User Open ID')
  .option('-x, --text <markdown>', 'Card body text (Markdown)')
  .option('-f, --text-file <path>', 'Read card body text from file (bypasses shell escaping)')
  .option('--title <text>', 'Card header title')
  .option('--color <color>', 'Header color (blue/red/orange/purple/etc)', 'blue')
  .option('--button-text <text>', 'Bottom button text')
  .option('--button-url <url>', 'Bottom button URL')
  .option('--text-size <size>', 'Text size (normal/heading/heading-1/etc)')
  .option('--text-align <align>', 'Text alignment (left/center/right)')
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

    // Priority: --text-file > --text > STDIN
    // Note: STDIN only fills "text" if image is NOT provided, OR if user wants both.
    // If image is present, text is optional.

    if (options.textFile) {
        // Handled inside sendCard
    } else if (!textContent) {
        try {
             const stdinText = await readStdin();
             if (stdinText.trim()) {
                 options.text = stdinText;
             }
        } catch (e) {
            // ignore stdin error
        }
    }

    // Requirement: Must have at least one content type (Text OR Image)
    if (!options.text && !options.textFile && !options.imagePath) {
        console.error('Error: Either --text, --text-file, --image-path, or STDIN content must be provided.');
        process.exit(1);
    }

    sendCard(options);
})();

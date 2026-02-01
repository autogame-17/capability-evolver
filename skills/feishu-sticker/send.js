const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const FormData = require('form-data');
const { execSync } = require('child_process');
// Try to resolve ffmpeg-static from workspace root
let ffmpegPath;
try {
    ffmpegPath = require('ffmpeg-static');
} catch (e) {
    try {
        ffmpegPath = require(path.resolve(__dirname, '../../node_modules/ffmpeg-static'));
    } catch (e2) {
        console.warn('Warning: ffmpeg-static not found. GIF conversion will fail.');
    }
}

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// Credentials
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

async function getToken() {
    try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
        });
        const data = await res.json();
        return data.tenant_access_token;
    } catch (e) {
        console.error('Failed to get token:', e.message);
        process.exit(1);
    }
}

async function uploadImage(token, filePath) {
    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append('image', fs.createReadStream(filePath));

    try {
        const axios = require('axios');
        const res = await axios.post('https://open.feishu.cn/open-apis/im/v1/images', formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            }
        });
        return res.data.data.image_key;
    } catch (e) {
        console.error('Upload failed:', e.response ? e.response.data : e.message);
        process.exit(1);
    }
}

async function sendSticker(options) {
    const token = await getToken();
    const stickerDir = path.resolve('/home/crishaocredits/.openclaw/media/stickers');
    let selectedFile;

    if (options.file) {
        selectedFile = path.resolve(options.file);
    } else {
        try {
            // Prioritize WebP, allow others
            const files = fs.readdirSync(stickerDir).filter(f => /\.(webp|jpg|png|gif)$/i.test(f));
            if (files.length === 0) {
                console.error('No stickers found in', stickerDir);
                process.exit(1);
            }
            const randomFile = files[Math.floor(Math.random() * files.length)];
            selectedFile = path.join(stickerDir, randomFile);
        } catch (e) {
            console.error('Error reading sticker directory:', e.message);
            process.exit(1);
        }
    }

    // GIF -> WebP Conversion
    if (selectedFile.toLowerCase().endsWith('.gif') && ffmpegPath) {
        console.log('Detected GIF. Converting to WebP (Efficiency Protocol)...');
        const webpPath = selectedFile.replace(/\.gif$/i, '.webp');
        try {
            execSync(`${ffmpegPath} -i "${selectedFile}" -c:v libwebp -lossless 0 -q:v 75 -loop 0 -an -vsync 0 -y "${webpPath}"`, { stdio: 'pipe' });
            
            if (fs.existsSync(webpPath)) {
                // Determine if we should delete the original
                // If it's in our sticker stash, yes. If it's a user-provided path outside, maybe/maybe not.
                // Assuming safer to replace for protocol compliance.
                try {
                    fs.unlinkSync(selectedFile);
                    console.log('Original GIF deleted.');
                } catch (delErr) {
                    console.warn('Could not delete original GIF:', delErr.message);
                }
                selectedFile = webpPath;
            }
        } catch (e) {
            console.error('Conversion failed, proceeding with original:', e.message);
        }
    }

    console.log(`Sending sticker: ${selectedFile}`);

    // Caching
    const cachePath = path.join(__dirname, 'image_key_cache.json');
    let cache = {};
    if (fs.existsSync(cachePath)) {
        try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) {}
    }

    const fileName = path.basename(selectedFile);
    let imageKey = cache[fileName];

    if (!imageKey) {
        console.log('Uploading image...');
        imageKey = await uploadImage(token, selectedFile);
        if (imageKey) {
            cache[fileName] = imageKey;
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        }
    } else {
        console.log('Using cached image_key:', imageKey);
    }

    // Determine receive_id_type
    let receiveIdType = 'open_id';
    if (options.target.startsWith('oc_')) {
        receiveIdType = 'chat_id';
    }

    // Send
    try {
        const axios = require('axios');
        const res = await axios.post(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
            {
                receive_id: options.target,
                msg_type: 'image',
                content: JSON.stringify({ image_key: imageKey })
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('Success:', JSON.stringify(res.data.data, null, 2));
    } catch (e) {
        console.error('Send failed:', e.response ? e.response.data : e.message);
        process.exit(1);
    }
}

program
  .requiredOption('-t, --target <open_id>', 'Target User Open ID')
  .option('-f, --file <path>', 'Specific image file path (optional)')
  .option('-q, --query <text>', 'Search query (e.g., "angry cat", "happy")')
  .option('-e, --emotion <emotion>', 'Filter by emotion (e.g., "happy", "sad")')
  .parse(process.argv);

async function findSticker(options) {
    if (!options.query && !options.emotion) return null;
    
    // Call find.js as a subprocess to leverage its logic
    try {
        const findScript = path.join(__dirname, 'find.js');
        let cmd = `node "${findScript}" --json --random`;
        if (options.query) cmd += ` --query "${options.query}"`;
        if (options.emotion) cmd += ` --emotion "${options.emotion}"`;
        
        const stdout = execSync(cmd).toString();
        const result = JSON.parse(stdout);
        
        if (result.found && result.sticker && result.sticker.path) {
            console.log(`Smart match: ${result.sticker.emotion} [${result.sticker.keywords}]`);
            return result.sticker.path;
        }
    } catch (e) {
        console.warn("Smart search failed, falling back to random:", e.message);
    }
    return null;
}

(async () => {
    const opts = program.opts();
    
    // If query/emotion is provided, try to find a matching sticker
    if (opts.query || opts.emotion) {
        const foundPath = await findSticker(opts);
        if (foundPath) {
            opts.file = foundPath;
        } else {
            console.log("No matching sticker found, falling back to random.");
        }
    }
    
    await sendSticker(opts);
})();

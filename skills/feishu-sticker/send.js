const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

async function getToken() {
    const now = Math.floor(Date.now() / 1000);

    // 1. Try Memory Cache (File)
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            if (cached.token && cached.expire > now + 60) {
                return cached.token;
            }
        } catch (e) {}
    }

    try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
        });
        const data = await res.json();
        
        if (data.code !== 0) throw new Error(`API Error: ${data.msg}`);

        // 2. Update Memory Cache (File)
        try {
            const cacheData = {
                token: data.tenant_access_token,
                expire: now + data.expire
            };
            const cacheDir = path.dirname(TOKEN_CACHE_FILE);
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        } catch (e) {
            console.error("Failed to write token cache:", e.message);
        }

        return data.tenant_access_token;
    } catch (e) {
        console.error('Failed to get token:', e.message);
        process.exit(1);
    }
}

async function uploadImage(token, filePath) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const formData = new FormData();
            formData.append('image_type', 'message');
            // Re-create stream for each attempt to avoid "stream closed" errors
            formData.append('image', fs.createReadStream(filePath));

            const axios = require('axios');
            const res = await axios.post('https://open.feishu.cn/open-apis/im/v1/images', formData, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...formData.getHeaders()
                },
                timeout: 10000 // 10s timeout
            });
            return res.data.data.image_key;
        } catch (e) {
            const isLast = attempt === MAX_RETRIES;
            const errMsg = e.response ? JSON.stringify(e.response.data) : e.message;
            console.warn(`[Attempt ${attempt}/${MAX_RETRIES}] Upload failed: ${errMsg}`);
            
            if (isLast) {
                console.error('Final upload failure.');
                process.exit(1);
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
        }
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
            // -loop 0 ensures animation loops are preserved
            // -c:v libwebp, -lossless 0 (lossy), -q:v 75 (quality), -an (remove audio)
            // -vsync 0 prevents frame duplication issues
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

    // Caching (Enhanced with MD5 Hash)
    const cachePath = path.join(__dirname, 'image_key_cache.json');
    let cache = {};
    if (fs.existsSync(cachePath)) {
        try {
            const rawCache = fs.readFileSync(cachePath, 'utf8');
            if (rawCache.trim()) {
                cache = JSON.parse(rawCache);
            }
        } catch (e) {
            console.warn(`[Cache Warning] Corrupt cache file detected: ${e.message}`);
            try {
                // Backup corrupt file to prevent total data loss
                const backupPath = cachePath + '.corrupt.' + Date.now();
                fs.copyFileSync(cachePath, backupPath);
                console.warn(`[Cache Warning] Backed up corrupt cache to ${backupPath}`);
            } catch (backupErr) {
                console.error('[Cache Error] Failed to backup corrupt cache:', backupErr.message);
            }
            // Proceed with empty cache (safe default), but original data is saved
        }
    }

    // Calculate file hash for deduplication and content validation
    const fileBuffer = fs.readFileSync(selectedFile);
    const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');

    // Check cache by Hash (Primary) or Filename (Legacy Fallback)
    const fileName = path.basename(selectedFile);
    let imageKey = cache[fileHash] || cache[fileName];

    if (!imageKey) {
        console.log(`Uploading image (Hash: ${fileHash.substring(0, 8)})...`);
        imageKey = await uploadImage(token, selectedFile);
        if (imageKey) {
            // Save with both keys for backward compatibility and robustness
            cache[fileHash] = imageKey;
            // Also cache by filename to maintain legacy lookup speed if needed, but hash is preferred
            cache[fileName] = imageKey;
            
            // Atomic write to prevent corruption
            const tempPath = `${cachePath}.tmp`;
            try {
                fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2));
                fs.renameSync(tempPath, cachePath);
            } catch (writeErr) {
                console.warn('Warning: Failed to write cache atomically:', writeErr.message);
                // Fallback to direct write if rename fails (e.g. cross-device link)
                try {
                     fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
                } catch (e) {}
            }
        }
    } else {
        console.log(`Using cached image_key (Hash: ${fileHash.substring(0, 8)})`);
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
  .option('-t, --target <open_id>', 'Target User Open ID')
  .option('-f, --file <path>', 'Specific image file path (optional)')
  .option('-q, --query <text>', 'Search query (e.g., "angry cat", "happy")')
  .option('-e, --emotion <emotion>', 'Filter by emotion (e.g., "happy", "sad")')
  .parse(process.argv);

function getAutoTarget() {
    // 1. Env Var (Highest Priority)
    if (process.env.FEISHU_TARGET_ID) return process.env.FEISHU_TARGET_ID;

    // 2. Shared Context (Active Session)
    try {
        const contextPath = path.resolve(__dirname, '../../memory/context.json');
        if (fs.existsSync(contextPath)) {
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            if (context.last_target_id) return context.last_target_id;
        }
    } catch (e) {}

    // 3. Last Menu Interaction (Fallback)
    try {
        const menuPath = path.resolve(__dirname, '../../memory/menu_events.json');
        if (fs.existsSync(menuPath)) {
            const events = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
            if (events.length > 0) return events[events.length - 1].user_id;
        }
    } catch (e) {}

    // 4. Default to Master
    return 'ou_cdc63fe05e88c580aedead04d851fc04'; 
}

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

    // Auto-detect target if missing
    if (!opts.target) {
        opts.target = getAutoTarget();
        console.log(`Auto-detected target: ${opts.target}`);
    }
    
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

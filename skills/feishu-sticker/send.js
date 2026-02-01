const os = require('os');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { program } = require('commander');
const FormData = require('form-data');
// Try to resolve ffmpeg-static from workspace root
let ffmpegPath;
const localStaticPath = path.resolve(__dirname, '../../bin/ffmpeg');
if (fs.existsSync(localStaticPath)) {
    ffmpegPath = localStaticPath;
} else {
    try {
        // Robust require: search node_modules
        ffmpegPath = require.resolve('ffmpeg-static');
        ffmpegPath = require(ffmpegPath);
    } catch (e) {
        try {
            ffmpegPath = require(path.resolve(__dirname, '../../node_modules/ffmpeg-static'));
        } catch (e2) {
            console.warn('Warning: ffmpeg-static not found. GIF conversion will fail.');
        }
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

async function getToken(forceRefresh = false) {
    const now = Math.floor(Date.now() / 1000);

    // 1. Try Memory Cache (File)
    if (!forceRefresh && fs.existsSync(TOKEN_CACHE_FILE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            if (cached.token && cached.expire > now + 60) {
                return cached.token;
            }
        } catch (e) {}
    }

    if (forceRefresh) {
        try { if (fs.existsSync(TOKEN_CACHE_FILE)) fs.unlinkSync(TOKEN_CACHE_FILE); } catch(e) {}
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

async function executeWithAuthRetry(operation) {
    let token = await getToken();
    try {
        return await operation(token);
    } catch (e) {
        const msg = e.message || '';
        const isAuthError = msg.includes('9999166') || 
                           (msg.toLowerCase().includes('token') && (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expire')));
        
        if (isAuthError) {
            console.warn(`[Feishu-Sticker] Auth Error (${msg}). Refreshing token...`);
            token = await getToken(true);
            return await operation(token);
        }
        throw e;
    }
}

async function uploadImage(token, filePath) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const fileBuffer = fs.readFileSync(filePath);
            const blob = new Blob([fileBuffer]);
            const formData = new FormData();
            formData.append('image_type', 'message');
            formData.append('image', blob, path.basename(filePath));

            const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            const data = await res.json();

            if (data.code !== 0) {
                if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                     throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
                }
                throw new Error(JSON.stringify(data));
            }
            return data.data.image_key;
        } catch (e) {
            if (e.message.includes('Feishu Auth Error')) throw e;

            const isLast = attempt === MAX_RETRIES;
            console.warn(`[Attempt ${attempt}/${MAX_RETRIES}] Upload failed: ${e.message}`);
            
            if (isLast) throw e;
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
        }
    }
}

async function sendSticker(options) {
    await executeWithAuthRetry(async (token) => {
        return await sendStickerLogic(token, options);
    });
}

async function sendStickerLogic(token, options) {
    const stickerDir = process.env.STICKER_DIR 
        ? path.resolve(process.env.STICKER_DIR) 
        : path.resolve(path.join(os.homedir(), '.openclaw/media/stickers'));
    let selectedFile;
    let isTempFile = false; // Track if we created a temp file to clean up

    if (options.file) {
        selectedFile = path.resolve(options.file);
    } else {
        if (!fs.existsSync(stickerDir)) {
             console.warn(`Sticker directory missing: ${stickerDir}. Creating...`);
             try { fs.mkdirSync(stickerDir, { recursive: true }); } catch (e) {
                 console.error('Failed to create sticker directory:', e.message);
                 process.exit(1);
             }
        }
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
            const ffmpegArgs = [
                '-i', selectedFile,
                '-c:v', 'libwebp',
                '-lossless', '0',
                '-q:v', '75',
                '-loop', '0',
                '-an',
                '-vsync', '0', 
                '-vf', 'scale=\'min(320,iw)\':-2',
                '-y',
                webpPath
            ];
            spawnSync(ffmpegPath, ffmpegArgs, { stdio: 'pipe' });
            
            if (fs.existsSync(webpPath)) {
                // SAFETY CHECK: Only delete if it's in our internal sticker stash
                const isInStickerDir = path.resolve(selectedFile).startsWith(stickerDir);
                
                if (isInStickerDir) {
                    try {
                        fs.unlinkSync(selectedFile);
                        console.log('Original GIF deleted (Internal Storage Cleanup).');
                    } catch (delErr) {
                        console.warn('Could not delete original GIF:', delErr.message);
                    }
                } else {
                    console.log('External file detected. Preserving original GIF.');
                }
                selectedFile = webpPath;
            }
        } catch (e) {
            console.error('Conversion failed, proceeding with original:', e.message);
        }
    }

    console.log(`Sending sticker: ${selectedFile}`);

    // Optimization: Large Image Compression (>5MB) to avoid API errors
    if (ffmpegPath) {
        try {
            const stats = fs.statSync(selectedFile);
            const LIMIT_BYTES = 5 * 1024 * 1024; // 5MB
            if (stats.size > LIMIT_BYTES) {
                console.log(`[Compression] Image is ${(stats.size/1024/1024).toFixed(2)}MB (>5MB). Compressing...`);
                // Use a temp file for compression output
                const compressedPath = path.join(path.dirname(selectedFile), `temp_compressed_${Date.now()}.webp`);
                
                const args = ['-i', selectedFile, '-c:v', 'libwebp', '-q:v', '60', '-y', compressedPath];
                const res = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
                
                if (res.status === 0 && fs.existsSync(compressedPath)) {
                    const newStats = fs.statSync(compressedPath);
                    if (newStats.size < stats.size && newStats.size < LIMIT_BYTES) {
                        console.log(`[Compression] Success: ${(newStats.size/1024/1024).toFixed(2)}MB.`);
                        selectedFile = compressedPath;
                        isTempFile = true; // Mark for deletion
                    } else {
                         console.warn('[Compression] Failed to reduce size below limit.');
                         try { fs.unlinkSync(compressedPath); } catch(e) {}
                    }
                }
            }
        } catch (e) {
            console.warn('[Compression] Error:', e.message);
        }
    }

    try {
        // Caching (Enhanced with MD5 Hash)
        // Unified Cache: Use the shared memory file (same as feishu-card) to prevent duplicate uploads
        const cachePath = path.resolve(__dirname, '../../memory/feishu_image_keys.json');
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
                    const backupPath = cachePath + '.corrupt.' + Date.now();
                    fs.copyFileSync(cachePath, backupPath);
                } catch (backupErr) {}
            }
        }

        // Calculate file hash
        const fileBuffer = fs.readFileSync(selectedFile);
        const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
        const fileName = path.basename(selectedFile);
        let imageKey = cache[fileHash] || cache[fileName];

        if (!imageKey) {
            console.log(`Uploading image (Hash: ${fileHash.substring(0, 8)})...`);
            imageKey = await uploadImage(token, selectedFile);
            if (imageKey) {
                cache[fileHash] = imageKey;
                cache[fileName] = imageKey;
                try {
                    const tempPath = `${cachePath}.tmp`;
                    fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2));
                    fs.renameSync(tempPath, cachePath);
                } catch (writeErr) {}
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
            const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    receive_id: options.target,
                    msg_type: 'image',
                    content: JSON.stringify({ image_key: imageKey })
                })
            });
            const data = await res.json();
            
            if (data.code !== 0) {
                if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                     throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
                }
                throw new Error(JSON.stringify(data));
            }

            console.log('Success:', JSON.stringify(data.data, null, 2));
        } catch (e) {
            if (e.message.includes('Feishu Auth Error')) throw e;
            console.error('Send failed:', e.message);
            throw e; 
        }
    } finally {
        // CLEANUP: Delete temp file if we created it during compression
        if (isTempFile && fs.existsSync(selectedFile)) {
            try {
                fs.unlinkSync(selectedFile);
                console.log(`[Cleanup] Deleted temporary compressed file: ${path.basename(selectedFile)}`);
            } catch (cleanupErr) {
                console.warn(`[Cleanup Warning] Failed to delete temp file: ${cleanupErr.message}`);
            }
        }
    }
}

program
  .option('-t, --target <open_id>', 'Target User Open ID')
  .option('-f, --file <path>', 'Specific image file path (optional)')
  .option('-q, --query <text>', 'Search query (e.g., "angry cat", "happy")')
  .option('-e, --emotion <emotion>', 'Filter by emotion (e.g., "happy", "sad")')
  .parse(process.argv);

function getAutoTarget() {
    // 1. Explicitly provided via CLI
    if (program.opts().target) return program.opts().target;

    // 2. Environment Variable (Priority)
    if (process.env.FEISHU_TARGET_ID) return process.env.FEISHU_TARGET_ID;

    // 3. Shared Context File (New Standard)
    try {
        const contextPath = path.resolve(__dirname, '../../memory/context.json');
        if (fs.existsSync(contextPath)) {
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            
            // Priority: Group Chat (oc_) > User (ou_)
            if (context.last_active_chat && context.last_active_chat.startsWith('oc_')) {
                console.log(`[Feishu-Sticker] Target Source: context.json (Group: ${context.last_active_chat})`);
                return context.last_active_chat;
            }
            
            if (context.last_active_user) {
                console.log(`[Feishu-Sticker] Target Source: context.json (User: ${context.last_active_user})`);
                return context.last_active_user;
            }

            if (context.last_active_chat) {
                console.log(`[Feishu-Sticker] Target Source: context.json (Chat: ${context.last_active_chat})`);
                return context.last_active_chat;
            }
        }
    } catch (e) {}

    // 4. Menu Events Log (Fallback to last interactor)
    try {
        const menuPath = path.resolve(__dirname, '../../memory/menu_events.json');
        if (fs.existsSync(menuPath)) {
            // Optimization: Read only last 10KB to avoid parsing huge JSON array
            const stats = fs.statSync(menuPath);
            const size = stats.size;
            const readSize = Math.min(size, 10240); // 10KB tail
            const buffer = Buffer.alloc(readSize);
            const fd = fs.openSync(menuPath, 'r');
            fs.readSync(fd, buffer, 0, readSize, size - readSize);
            fs.closeSync(fd);
            const tail = buffer.toString('utf8');
            
            // Find last "open_id": "ou_..." OR "chat_id": "oc_..." (Group or User)
            const matches = [...tail.matchAll(/"(?:open_id|chat_id|user_id|open_chat_id)"\s*:\s*"(o[uc]_[a-z0-9]+)"/g)];
            if (matches.length > 0) {
                 const lastId = matches[matches.length - 1][1];
                 console.log(`[Feishu-Sticker] Target Source: menu_events.json (Tail Search: ${lastId})`);
                 return lastId;
            }
        }
    } catch (e) {
        // Fallback to full read if optimization fails (unlikely)
    }
    
    // 5. Parse USER.md for Master ID (Robust Fallback)
    try {
        const userMdPath = path.resolve(__dirname, '../../USER.md');
        if (fs.existsSync(userMdPath)) {
            const userMd = fs.readFileSync(userMdPath, 'utf8');
            // Regex to find "Feishu ID: `ou_...`" under "Owner" or "Master" section
            const masterMatch = userMd.match(/(?:Master|Owner).*?Feishu ID:.*?`(ou_[a-z0-9]+)`/s);
            if (masterMatch && masterMatch[1]) {
                console.log(`[Feishu-Sticker] Target Source: USER.md (Master: ${masterMatch[1]})`);
                return masterMatch[1];
            }
            // Fallback: Just find the first "ou_" ID in the file if specific Master tag fails
            const firstOu = userMd.match(/`(ou_[a-z0-9]+)`/);
            if (firstOu && firstOu[1]) {
                 console.log(`[Feishu-Sticker] Target Source: USER.md (First Found: ${firstOu[1]})`);
                 return firstOu[1];
            }
        }
    } catch (e) {}
    
    // 6. Master ID (Env Fallback)
    if (process.env.MASTER_ID) return process.env.MASTER_ID;

    console.log('[Feishu-Sticker] Target Source: Hardcoded Master (Fallback)');
    return 'ou_cdc63fe05e88c580aedead04d851fc04'; 
}

async function findSticker(options) {
    if (!options.query && !options.emotion) return null;
    
    try {
        const { findSticker: findStickerFn } = require('./find.js');
        // Use true for 'random' parameter to keep behavior consistent with CLI default
        const result = findStickerFn(options.query, options.emotion, true);
        
        if (result && result.path) {
            console.log(`Smart match: ${result.emotion} [${result.keywords}]`);
            return result.path;
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

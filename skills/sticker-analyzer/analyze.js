const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto"); // Added for optimization
const { spawnSync } = require('child_process');

// Optimization: Cleaner FFmpeg resolution
let ffmpegPath;
const localStaticPath = path.resolve(__dirname, '../../bin/ffmpeg');
if (fs.existsSync(localStaticPath)) {
    ffmpegPath = localStaticPath;
} else {
    try {
        ffmpegPath = require('ffmpeg-static');
    } catch (e) {
        try {
            // Fallback for monorepo/nested structures
            ffmpegPath = require(require.resolve('ffmpeg-static', { paths: [process.cwd(), __dirname] }));
        } catch (e2) {
            // Silent fail, will warn only if GIF encountered
        }
    }
}

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); 

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY not set");
    process.exit(1);
}

const STICKER_DIR = process.env.STICKER_DIR 
    ? path.resolve(process.env.STICKER_DIR)
    : path.resolve(path.join(process.env.HOME || '/home/crishaocredits', '.openclaw/media/stickers'));

if (!fs.existsSync(STICKER_DIR)) {
    console.log(`Creating sticker directory: ${STICKER_DIR}`);
    fs.mkdirSync(STICKER_DIR, { recursive: true });
}

const TRASH_DIR = path.join(STICKER_DIR, "trash");
const INDEX_FILE = path.join(STICKER_DIR, 'index.json');

// Safety: Max file size to prevent OOM/Timeouts (10MB)
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const genAI = new GoogleGenerativeAI(API_KEY);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

// Stability Tuning: Reduced concurrency and increased delay to prevent Rate Limit (429) errors
const CONCURRENCY = 2;
const BATCH_DELAY_MS = 4000;

if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true });

function getFileHash(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const hashSum = crypto.createHash('md5');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    } catch (e) {
        return null;
    }
}

function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: fs.readFileSync(path).toString("base64"),
      mimeType,
    },
  };
}

function parseGeminiJson(text) {
    try {
        let clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            clean = clean.substring(firstBrace, lastBrace + 1);
        }
        return JSON.parse(clean);
    } catch (e) {
        return null;
    }
}

function saveIndex(index) {
    const tempFile = `${INDEX_FILE}.tmp`;
    try {
        fs.writeFileSync(tempFile, JSON.stringify(index, null, 2));
        fs.renameSync(tempFile, INDEX_FILE);
    } catch (e) {
        console.error("Failed to save index atomically:", e.message);
    }
}

async function analyzeFile(file, index) {
    let filePath = path.join(STICKER_DIR, file);
    
    // Optimization: Quick stat check
    try {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
            console.log(`[ SKIP ] ${file} (Too large: ${(stats.size/1024/1024).toFixed(2)}MB)`);
            return false;
        }
    } catch (e) {
        console.error(`[ ERROR ] Cannot stat ${file}`);
        return false;
    }

    // Optimization: Content-Based Deduplication (Save tokens!)
    const fileHash = getFileHash(filePath);
    if (fileHash) {
        // Check if any *other* file in index shares this hash
        // (We might be re-processing the same file if index didn't block it, but !index[file] usually blocks it.
        // This catches renaming a file or uploading duplicate.)
        const existingKey = Object.keys(index).find(k => index[k].hash === fileHash);
        if (existingKey) {
            const match = index[existingKey];
            console.log(`[ CACHE ] ${file} is duplicate of ${existingKey} (Hash: ${fileHash.slice(0,6)}). Copying metadata.`);
            index[file] = {
                path: filePath, // Keep its own path
                emotion: match.emotion,
                keywords: match.keywords,
                hash: fileHash,
                addedAt: Date.now()
            };
            return true; // Done!
        }
    }

    const ext = path.extname(file).toLowerCase();
    let mimeType = ext === ".png" ? "image/png" : (ext === ".webp" ? "image/webp" : "image/jpeg");
    let currentFile = file;

    // GIF Handling
    if (ext === '.gif') {
        if (!ffmpegPath) {
            console.log(`[ SKIP ] ${file} (ffmpeg missing for GIF)`);
            return false;
        }
        
        const webpPath = filePath.replace(/\.gif$/i, '.webp');
        if (fs.existsSync(webpPath)) {
             console.log(`[ REUSE ] Found existing WebP for ${file}`);
             filePath = webpPath;
             currentFile = path.basename(webpPath);
             mimeType = "image/webp";
        } else {
            console.log(`[ CONVERT ] ${file} -> WebP`);
            try {
                // Optimized ffmpeg args: lower quality is fine for analysis, faster speed
                // Using spawnSync for safety and better arg handling
                const args = [
                    '-i', filePath,
                    '-c:v', 'libwebp',
                    '-lossless', '0',
                    '-q:v', '60',
                    '-loop', '0',
                    '-an',
                    '-vsync', '0',
                    '-vf', 'scale=\'min(320,iw)\':-2', // Downscale for faster analysis
                    '-y',
                    webpPath
                ];
                
                const result = spawnSync(ffmpegPath, args, { stdio: 'ignore' });
                
                if (result.error) throw result.error;
                
                if (fs.existsSync(webpPath)) {
                    // Check if we can safely delete original. 
                    // Policy: Keep original if conversion was for analysis only? 
                    // No, previous logic deleted it. We'll stick to that to save space.
                    try {
                        fs.unlinkSync(filePath); 
                    } catch(e) {}
                    filePath = webpPath;
                    currentFile = path.basename(webpPath);
                    mimeType = "image/webp";
                } else {
                    throw new Error("Conversion output missing");
                }
            } catch (e) {
                console.error(`[ ERROR ] Convert failed ${file}: ${e.message}`);
                return false;
            }
        }
        
        if (index[currentFile]) return false;
    }

    console.log(`[ ANALYZE ] ${currentFile}`);

    try {
      // Optimized Prompt: Shorter, cheaper tokens, clearer instructions
      const prompt = `Classify image. JSON only.
      Rules:
      1. "is_sticker": true if meme/reaction/clipart. false if screenshot/photo/text.
      2. "emotion": 1-2 word emotion (e.g. "happy", "crying") or null.
      3. "keywords": max 3 relevant tags.
      
      Example: {"is_sticker": true, "emotion": "smug", "keywords": ["pepe", "frog"]}`;

      const imagePart = fileToGenerativePart(filePath, mimeType);
      
      const result = await Promise.race([
          model.generateContent([prompt, imagePart]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Gemini API Timeout")), 25000))
      ]);
      
      const response = await result.response;
      const text = response.text();
      const analysis = parseGeminiJson(text);

      if (!analysis) {
          console.error(`[ FAIL ] Parse error ${currentFile}`);
          return false;
      }

      if (!analysis.is_sticker) {
        console.log(`[ TRASH ] ${currentFile}`);
        const trashPath = path.join(TRASH_DIR, currentFile);
        if (fs.existsSync(trashPath)) fs.unlinkSync(trashPath);
        fs.renameSync(filePath, trashPath);
        if (index[currentFile]) delete index[currentFile]; 
      } else {
        console.log(`[ INDEX ] ${currentFile}: ${analysis.emotion}`);
        index[currentFile] = {
            path: filePath,
            emotion: analysis.emotion,
            keywords: analysis.keywords || [],
            hash: fileHash,
            addedAt: Date.now()
        };
      }
      return true;

    } catch (e) {
      console.error(`[ ERROR ] Analysis failed ${currentFile}: ${e.message}`);
      return false;
    }
}

async function run() {
  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
      try { 
          index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); 
          // Optimization: Backfill hashes for legacy entries
          let backfilled = 0;
          Object.keys(index).forEach(key => {
              if (!index[key].hash && fs.existsSync(index[key].path)) {
                  index[key].hash = getFileHash(index[key].path);
                  backfilled++;
              }
          });
          if (backfilled > 0) console.log(`[ UPDATE ] Backfilled MD5 hashes for ${backfilled} stickers.`);
      } catch (e) {
          console.error("Corrupt index.json, starting fresh.");
          if (fs.existsSync(INDEX_FILE)) fs.renameSync(INDEX_FILE, INDEX_FILE + '.bak');
      }
  }

  let allFiles = [];
  try {
      allFiles = fs.readdirSync(STICKER_DIR);
  } catch (e) {
      console.error(`Directory missing: ${STICKER_DIR}`);
      return;
  }
  
  // 1. Cleanup Stale
  let dirty = false;
  Object.keys(index).forEach(key => {
      if (!allFiles.includes(key) && !fs.existsSync(path.join(STICKER_DIR, key))) {
          delete index[key];
          dirty = true;
      }
  });

  // 2. Filter
  const filesToProcess = allFiles.filter(file => {
    const ext = path.extname(file).toLowerCase();
    // Only process supported images
    return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) && !index[file];
  });

  console.log(`Pending: ${filesToProcess.length} files.`);

  if (filesToProcess.length === 0) {
      if (dirty) saveIndex(index);
      return;
  }

  // 3. Batch
  for (let i = 0; i < filesToProcess.length; i += CONCURRENCY) {
      const batch = filesToProcess.slice(i, i + CONCURRENCY);
      // Wait for batch to finish
      const results = await Promise.all(batch.map(f => analyzeFile(f, index)));
      
      if (results.some(Boolean)) saveIndex(index);
      // Rate limit protection
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
  
  console.log("Done.");
}

run();
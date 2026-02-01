const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
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

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); // Load workspace .env

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY not set");
    process.exit(1);
}

const STICKER_DIR = "/home/crishaocredits/.openclaw/media/stickers";
const TRASH_DIR = path.join(STICKER_DIR, "trash");

const genAI = new GoogleGenerativeAI(API_KEY);

// Use the specific model found via curl or fallback
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true });

function fileToGenerativePart(path, mimeType) {
  return {
    inlineData: {
      data: fs.readFileSync(path).toString("base64"),
      mimeType,
    },
  };
}

async function run() {
  const files = fs.readdirSync(STICKER_DIR).filter(file => {
    const ext = path.extname(file).toLowerCase();
    // Allow GIFs now as we will convert them
    return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) && fs.statSync(path.join(STICKER_DIR, file)).isFile();
  });

  console.log(`Found ${files.length} images to analyze.`);

  for (const file of files) {
    let filePath = path.join(STICKER_DIR, file);
    let mimeType = file.endsWith(".png") ? "image/png" : (file.endsWith(".webp") ? "image/webp" : "image/jpeg");
    let currentFile = file;

    // Convert GIF to WebP if found
    if (file.toLowerCase().endsWith('.gif')) {
        if (!ffmpegPath) {
            console.log(`Skipping ${file} (ffmpeg not found for conversion)`);
            continue;
        }
        console.log(`Converting GIF ${file} to WebP...`);
        const webpPath = filePath.replace(/\.gif$/i, '.webp');
        try {
            execSync(`${ffmpegPath} -i "${filePath}" -c:v libwebp -lossless 0 -q:v 75 -loop 0 -an -vsync 0 -y "${webpPath}"`, { stdio: 'pipe' });
            if (fs.existsSync(webpPath)) {
                fs.unlinkSync(filePath); // Delete original GIF
                filePath = webpPath;
                currentFile = path.basename(webpPath);
                mimeType = "image/webp";
                console.log(`Converted to ${currentFile}`);
            }
        } catch (e) {
            console.error(`Failed to convert ${file}, skipping:`, e.message);
            continue;
        }
    }

    console.log(`Analyzing ${currentFile}...`);

    try {
      const prompt = `Analyze this image. 
      First, determine if it is a "sticker" or "meme" suitable for use in a chat conversation as a reaction.
      It is NOT a sticker if it is a screenshot of UI, document, real photo of papers, or complex diagram.
      It IS a sticker if it is a character, anime face, meme, or expressive icon.
      
      If it is a sticker, describe its EMOTION (e.g., happy, angry, confused, crying, smug) and KEYWORDS (e.g., cat, girl, computer, coffee).
      
      Reply with JSON ONLY: 
      {
        "is_sticker": boolean, 
        "reason": "string",
        "emotion": "string (or null if not sticker)",
        "keywords": ["tag1", "tag2"] (or empty if not sticker)
      }`;

      const imagePart = fileToGenerativePart(filePath, mimeType);
      const result = await model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      
      console.log(`Response: ${text}`);

      let analysis = {};
      try {
          const cleanJson = text.replace(/```json/g, "").replace(/```/g, "").trim();
          analysis = JSON.parse(cleanJson);
      } catch (e) {
          console.error("JSON parse failed");
      }

      if (!analysis.is_sticker) {
        console.log(`❌ Not a sticker. Moving to trash.`);
        fs.renameSync(filePath, path.join(TRASH_DIR, currentFile));
      } else {
        console.log(`✅ Sticker confirmed: ${analysis.emotion} [${analysis.keywords?.join(', ')}]`);
        
        // Update index
        const indexFile = path.join(STICKER_DIR, 'index.json');
        let index = {};
        if (fs.existsSync(indexFile)) {
            try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) {}
        }
        
        index[currentFile] = {
            path: filePath,
            emotion: analysis.emotion,
            keywords: analysis.keywords,
            addedAt: Date.now()
        };
        
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
      }

    } catch (e) {
      console.error(`Error processing ${currentFile}:`, e.message);
    }
    
    // Simple sleep to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }
}

run();

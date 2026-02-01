const { getTenantAccessToken } = require('./lib/auth');
const { resolveWiki } = require('./lib/wiki');
const { fetchDocxContent } = require('./lib/docx');
const { fetchSheetContent } = require('./lib/sheet');
const { fetchBitableContent } = require('./lib/bitable');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EXECUTION_TIMEOUT_MS = 30000; // 30 seconds hard timeout

async function main() {
  // Set a global watchdog timeout
  const watchdog = setTimeout(() => {
    // Write to stderr so it doesn't break JSON parsing if mixed
    console.error("Watchdog: Execution timed out."); 
    console.log(JSON.stringify({ error: "Execution timed out (30s limit reached)", status: "timeout" }));
    process.exit(1);
  }, EXECUTION_TIMEOUT_MS);

  const args = process.argv.slice(2);
  const command = args[0];
  const url = args[1];
  const noCache = args.includes('--no-cache');

  if (command !== 'fetch') {
    console.log(JSON.stringify({ error: "Usage: node index.js fetch <url> [--no-cache]", status: "usage_error" }));
    process.exit(1);
  }

  if (!url) {
    console.log(JSON.stringify({ error: "URL is required", status: "validation_error" }));
    process.exit(1);
  }

  try {
    // Ensure cache dir exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } else {
      // Probabilistic cleanup (10% chance) to prevent infinite growth
      // We do this BEFORE fetching to keep the disk tidy.
      if (Math.random() < 0.1) {
        cleanCache();
      }
    }

    // Attempt cache read
    // Use URL-safe Base64 for file names
    const cacheKey = Buffer.from(url).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);

    if (!noCache && fs.existsSync(cacheFile)) {
      const stats = fs.statSync(cacheFile);
      const age = Date.now() - stats.mtimeMs;
      
      if (age < CACHE_TTL_MS) {
        // Cache hit
        const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        cachedData._source = "cache";
        cachedData._cachedAt = stats.mtime;
        console.log(JSON.stringify(cachedData, null, 2));
        clearTimeout(watchdog);
        return;
      }
    }

    const accessToken = await getTenantAccessToken();
    const result = await processUrl(url, accessToken);
    
    // Save to cache
    if (result && !result.error) {
       fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
    }

    // Output JSON result
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.log(JSON.stringify({ error: error.message, stack: error.stack, status: "failed" }));
    process.exit(1);
  } finally {
    clearTimeout(watchdog);
  }
}

async function processUrl(url, accessToken) {
  // Regex to detect type and token
  // Wiki: /wiki/<token>
  // Docx: /docx/<token>
  // Doc: /docs/<token>
  // Sheets: /sheets/<token>
  // Bitable: /base/<token>

  const wikiRegex = /\/wiki\/([a-zA-Z0-9]+)/;
  const docxRegex = /\/docx\/([a-zA-Z0-9]+)/;
  const docRegex = /\/docs\/([a-zA-Z0-9]+)/;
  const sheetRegex = /\/sheets\/([a-zA-Z0-9]+)/;
  const bitableRegex = /\/base\/([a-zA-Z0-9]+)/;

  let token = '';
  let type = '';

  if (wikiRegex.test(url)) {
    token = url.match(wikiRegex)[1];
    type = 'wiki';
  } else if (docxRegex.test(url)) {
    token = url.match(docxRegex)[1];
    type = 'docx';
  } else if (docRegex.test(url)) {
    token = url.match(docRegex)[1];
    type = 'doc';
  } else if (sheetRegex.test(url)) {
    token = url.match(sheetRegex)[1];
    type = 'sheet';
  } else if (bitableRegex.test(url)) {
    token = url.match(bitableRegex)[1];
    type = 'bitable';
  } else {
    throw new Error("Unsupported Feishu URL format.");
  }

  // If Wiki, resolve to real object
  if (type === 'wiki') {
    const wikiInfo = await resolveWiki(token, accessToken);
    if (wikiInfo) {
      token = wikiInfo.obj_token;
      type = wikiInfo.obj_type;
      console.error(`Wiki resolved to: ${type} (${token})`); // Log to stderr to not pollute JSON output
    } else {
      throw new Error("Could not resolve Wiki info.");
    }
  }

  // Fetch content based on type
  if (type === 'docx') {
    return await fetchDocxContent(token, accessToken);
  } else if (type === 'doc') {
    return { error: "Legacy 'doc' format not fully implemented yet." };
  } else if (type === 'sheet') {
    return await fetchSheetContent(token, accessToken);
  } else if (type === 'bitable') {
    return await fetchBitableContent(token, accessToken);
  } else {
    return { error: `Unknown type: ${type}` };
  }
}

function cleanCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    // Delete files older than 1 hour (3600000 ms)
    const MAX_AGE = 60 * 60 * 1000;
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      // Skip token.json if it exists here (though it should be in cache/token.json, better safe)
      if (file === 'token.json') continue;

      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > MAX_AGE) {
           fs.unlinkSync(filePath);
        }
      } catch (e) {
        // Ignore individual file errors
      }
    }
  } catch (err) {
    // Ignore directory scan errors
  }
}

if (require.main === module) {
  main();
}

const { getTenantAccessToken } = require('./lib/auth');
const { resolveWiki } = require('./lib/wiki');
const { fetchDocxContent } = require('./lib/docx');
const { fetchSheetContent } = require('./lib/sheet');
const { fetchBitableContent } = require('./lib/bitable');
const fs = require('fs');
const path = require('path');
const { promises: fsPromises } = fs;

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
    }

    // Optimization: Run cleanup concurrently with logic (latency masking)
    // Only run probabilistic cleanup (10%)
    let cleanupPromise = Promise.resolve();
    if (Math.random() < 0.1) {
       cleanupPromise = cleanCacheAsync().catch(err => console.error(`[Cleanup Warning] ${err.message}`));
    }

    // Attempt cache read
    // Use URL-safe Base64 for file names
    const cacheKey = Buffer.from(url).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);

    if (!noCache && fs.existsSync(cacheFile)) {
      try {
        const stats = fs.statSync(cacheFile);
        const age = Date.now() - stats.mtimeMs;
        
        if (age < CACHE_TTL_MS) {
          // Cache hit
          const raw = fs.readFileSync(cacheFile, 'utf8');
          const cachedData = JSON.parse(raw);
          cachedData._source = "cache";
          cachedData._cachedAt = stats.mtime;
          console.log(JSON.stringify(cachedData, null, 2));
          
          // Wait for cleanup before exiting (since we are fast anyway)
          await cleanupPromise;
          clearTimeout(watchdog);
          return;
        }
      } catch (cacheErr) {
        // Stability: Handle corrupt cache gracefully
        console.error(`[Cache Error] Corrupt file detected, deleting: ${cacheErr.message}`);
        try { fs.unlinkSync(cacheFile); } catch(e){}
      }
    }

    const accessToken = await getTenantAccessToken();
    const result = await processUrl(url, accessToken);
    
    // Save to cache (Atomic)
    if (result && !result.error) {
       const tempFile = `${cacheFile}.tmp.${Date.now()}`;
       try {
           fs.writeFileSync(tempFile, JSON.stringify(result, null, 2));
           fs.renameSync(tempFile, cacheFile);
       } catch (writeErr) {
           console.error(`[Cache Write Error] ${writeErr.message}`);
           try { fs.unlinkSync(tempFile); } catch(e){}
       }
    }

    // Output JSON result
    console.log(JSON.stringify(result, null, 2));

    // Ensure cleanup is done (usually instant if started early)
    await cleanupPromise;

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

async function cleanCacheAsync() {
  try {
    const files = await fsPromises.readdir(CACHE_DIR);
    const now = Date.now();
    // Delete files older than 1 hour (3600000 ms)
    const MAX_AGE = 60 * 60 * 1000;
    
    // Process files in parallel chunks or just all at once (since just unlink)
    // Use Promise.allSettled to ensure one failure doesn't stop others
    await Promise.allSettled(files.map(async (file) => {
      if (!file.endsWith('.json')) return;
      if (file === 'token.json') return;

      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = await fsPromises.stat(filePath);
        if (now - stats.mtimeMs > MAX_AGE) {
           await fsPromises.unlink(filePath);
        }
      } catch (e) {
        // Ignore individual file errors (file might be gone)
      }
    }));
  } catch (err) {
    // Ignore directory scan errors
  }
}

if (require.main === module) {
  main();
}

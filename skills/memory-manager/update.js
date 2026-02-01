const fs = require('fs');
const path = require('path');
const { program } = require('commander');

// Configuration
const MAX_RETRIES = 15;
const RETRY_DELAY_MS = 200;
const LOCK_STALE_MS = 15000; // 15s max lock time (increased for safety)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalize(text) {
    // Normalize line endings to LF and strip trailing whitespace per line
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(line => line.trimEnd()).join('\n');
}

/**
 * Robust Async Lock Acquisition
 * Uses mkdir (atomic) + stale check loop
 */
async function acquireLock(targetFile) {
    const lockPath = `${targetFile}.lock`;
    let attempts = 0;

    while (attempts < MAX_RETRIES) {
        try {
            fs.mkdirSync(lockPath); // Atomic
            return lockPath;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e; // Unexpected error

            // Lock exists. Check staleness.
            try {
                const stats = fs.statSync(lockPath);
                const age = Date.now() - stats.mtimeMs;
                
                if (age > LOCK_STALE_MS) {
                    console.warn(`[Lock] Found stale lock ${lockPath} (age: ${age}ms). Pruning...`);
                    try {
                        fs.rmdirSync(lockPath);
                        console.log(`[Lock] Stale lock removed. Retrying immediately.`);
                        continue; // Retry acquisition immediately
                    } catch (rmErr) {
                        // Someone else might have removed it or claimed it. 
                        // Just fall through to wait/retry.
                    }
                }
            } catch (statErr) {
                // Lock might have been removed between mkdir failure and stat.
                // This is good! Retry immediately.
                continue;
            }
        }

        // Wait and retry
        attempts++;
        const delay = RETRY_DELAY_MS + Math.floor(Math.random() * 100); // Jitter
        // console.log(`[Lock] Waiting ${delay}ms... (${attempts}/${MAX_RETRIES})`);
        await sleep(delay);
    }

    throw new Error(`Could not acquire lock for ${targetFile} after ${MAX_RETRIES} attempts.`);
}

function releaseLock(lockPath) {
    try {
        if (lockPath && fs.existsSync(lockPath)) {
            fs.rmdirSync(lockPath);
        }
    } catch (e) {
        // Ignore errors on release (e.g. if already gone)
    }
}

async function safeUpdate(filePath, options) {
    const absPath = path.resolve(filePath);
    let lockPath = null;

    try {
        // 1. Acquire Lock
        lockPath = await acquireLock(absPath);
        
        // CRITICAL SECTION START
        
        // 2. Read fresh content
        if (!fs.existsSync(absPath)) {
            if (options.operation === 'create') {
                fs.writeFileSync(absPath, '', 'utf8');
            } else {
                throw new Error(`File not found: ${absPath}`);
            }
        }
        
        let content = fs.readFileSync(absPath, 'utf8');
        
        // 3. Apply changes
        let modified = false;

        if (options.operation === 'replace') {
            const search = (options.old !== undefined) ? options.old : options.search;
            const replace = (options.new !== undefined) ? options.new : options.replace;
            
            if (search === undefined || replace === undefined) throw new Error("Replace requires --old and --new");

            // Try exact match first
            if (content.includes(search)) {
                content = content.replace(search, replace);
                modified = true;
                console.log("Status: Exact match successful.");
            } else {
                // Try normalized match
                const normContent = normalize(content);
                const normSearch = normalize(search);
                if (normContent.includes(normSearch)) {
                     // Note: We replace in the normalized version, effectively re-formatting the whole file.
                     // This is acceptable for Markdown files to maintain consistency.
                     content = normContent.replace(normSearch, replace);
                     modified = true;
                     console.log("Status: Normalized match successful.");
                } else {
                    console.error("Error: Text not found.");
                    if (lockPath) releaseLock(lockPath);
                    process.exit(1);
                }
            }
        } else if (options.operation === 'append') {
            if (!options.content) throw new Error("Append requires --content");
            // Ensure newline before append if file not empty
            if (content.length > 0 && !content.endsWith('\n')) content += '\n';
            content += options.content + '\n';
            modified = true;
            console.log("Status: Append successful.");
        } else if (options.operation === 'create') {
            // Already handled creation above, check content?
            if (options.content) {
                content = options.content;
                if (!content.endsWith('\n')) content += '\n';
                modified = true;
            }
        }

        // 4. Write back
        if (modified) {
            // Atomic Write via rename for extra safety (prevents partial reads by others)
            const tempPath = `${absPath}.tmp`;
            fs.writeFileSync(tempPath, content, 'utf8');
            fs.renameSync(tempPath, absPath);
            console.log("Success: Memory file updated safely.");
        } else {
            console.log("No changes needed.");
        }
        
        // CRITICAL SECTION END

    } catch (e) {
        console.error(`Update failed: ${e.message}`);
        process.exit(1);
    } finally {
        if (lockPath) releaseLock(lockPath);
    }
}

program
  .requiredOption('-f, --file <path>', 'Target file path', 'MEMORY.md')
  .requiredOption('-o, --operation <type>', 'Operation: replace | append | create')
  .option('--old <text>', 'Text to replace')
  .option('--new <text>', 'Replacement text')
  .option('--search <text>', 'Alias for --old')
  .option('--replace <text>', 'Alias for --new')
  .option('--content <text>', 'Content to append')
  .option('--content-file <path>', 'Read content from file')
  .option('--old-file <path>', 'Read old text from file')
  .option('--new-file <path>', 'Read new text from file')
  .parse(process.argv);

const options = program.opts();

// Handle file inputs
if (options.contentFile) options.content = fs.readFileSync(options.contentFile, 'utf8').trim();
if (options.oldFile) options.old = fs.readFileSync(options.oldFile, 'utf8').trim();
if (options.newFile) options.new = fs.readFileSync(options.newFile, 'utf8').trim();

safeUpdate(options.file, options);

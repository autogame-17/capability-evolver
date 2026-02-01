const fs = require('fs');
const path = require('path');
const { detectMime } = require('./lib/magic');
const { gifToPng } = require('./lib/convert');

const args = process.argv.slice(2);
const action = args[0];

// Parse --file arg
const fileIndex = args.indexOf('--file');
if (fileIndex === -1 || !args[fileIndex + 1]) {
    console.error(JSON.stringify({ error: 'Error: --file argument required' }));
    process.exit(1);
}
const filePath = args[fileIndex + 1];

if (!fs.existsSync(filePath)) {
    console.error(JSON.stringify({ error: `Error: File not found: ${filePath}` }));
    process.exit(1);
}

const MIME_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf'
};

try {
    if (action === 'detect') {
        const mime = detectMime(filePath);
        const ext = mime ? MIME_TO_EXT[mime] : null;
        console.log(JSON.stringify({ mime: mime || 'application/octet-stream', ext }));
        process.exit(0);

    } else if (action === 'fix') {
        const mime = detectMime(filePath);
        
        if (!mime) {
            // Unknown type, keep as is
            console.log(JSON.stringify({ 
                original: filePath, 
                fixed: filePath, 
                mime: 'application/octet-stream', 
                note: 'Could not detect magic bytes' 
            }));
            process.exit(0);
        }

        const correctExt = MIME_TO_EXT[mime];
        const currentExt = path.extname(filePath).replace('.', '').toLowerCase();

        if (correctExt && currentExt !== correctExt) {
            const dir = path.dirname(filePath);
            const name = path.basename(filePath, path.extname(filePath));
            let newPath = path.join(dir, `${name}.${correctExt}`);
            
            // Collision avoidance: If target exists, append _1, _2, etc.
            let counter = 1;
            while (fs.existsSync(newPath)) {
                newPath = path.join(dir, `${name}_${counter}.${correctExt}`);
                counter++;
            }

            try {
                fs.renameSync(filePath, newPath);
                
                console.log(JSON.stringify({ 
                    original: filePath, 
                    fixed: newPath, 
                    mime: mime,
                    note: `Renamed from .${currentExt} to .${correctExt}`
                }));
            } catch (renameErr) {
                console.error(JSON.stringify({ 
                    error: `Failed to rename file: ${renameErr.message}`,
                    code: renameErr.code
                }));
                process.exit(1);
            }
        } else {
            console.log(JSON.stringify({ 
                original: filePath, 
                fixed: filePath, 
                mime: mime,
                note: 'Extension already correct or mapping missing'
            }));
        }
        process.exit(0);

    } else if (action === 'convert') {
        const mime = detectMime(filePath);
        
        if (mime === 'image/gif') {
            gifToPng(filePath)
                .then(newPath => {
                    console.log(JSON.stringify({
                        original: filePath,
                        path: newPath,
                        mime: 'image/png',
                        converted: true
                    }));
                    process.exit(0);
                })
                .catch(err => {
                    console.error(JSON.stringify({ error: err.message }));
                    process.exit(1);
                });
        } else {
            // Passthrough if not GIF or conversion not needed
            console.log(JSON.stringify({
                path: filePath,
                mime: mime || 'application/octet-stream',
                converted: false
            }));
            process.exit(0);
        }

    } else {
        console.log(JSON.stringify({ error: 'Usage: node index.js [detect|fix|convert] --file <path>' }));
        process.exit(1);
    }
} catch (err) {
    console.error(JSON.stringify({ error: `Unexpected error: ${err.message}` }));
    process.exit(1);
}

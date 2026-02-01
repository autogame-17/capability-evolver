const fs = require('fs');

/**
 * Detects MIME type from file magic bytes
 * @param {string} filePath 
 * @returns {string|null} Detected MIME type or null
 */
function detectMime(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (stats.size < 4) return null; // Too small for any signature

        const buffer = Buffer.alloc(12); // Read first 12 bytes
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, Math.min(12, stats.size), 0);
        fs.closeSync(fd);

        const hex = buffer.toString('hex').toUpperCase();

        // JPEG
        if (hex.startsWith('FFD8FF')) return 'image/jpeg';
        
        // PNG
        if (hex.startsWith('89504E470D0A1A0A')) return 'image/png';
        
        // GIF
        if (hex.startsWith('47494638')) return 'image/gif'; // GIF87a or GIF89a
        
        // WEBP (RIFF....WEBP)
        if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
        
        // MP4 (ftypisom, ftypmp42, etc - usually starts at offset 4)
        // Common signature: ....ftyp
        const sub = buffer.subarray(4, 8).toString('ascii');
        if (sub === 'ftyp') return 'video/mp4';

        // PDF (%PDF)
        if (hex.startsWith('25504446')) return 'application/pdf';

        return null; // Unknown
    } catch (err) {
        // Return null on read error so main script handles it (or logging elsewhere)
        return null;
    }
}

module.exports = { detectMime };

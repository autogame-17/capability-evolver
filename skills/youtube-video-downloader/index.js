const fs = require('fs');
const ytdl = require('ytdl-core');
const path = require('path');

// 🧬 EVOLVED LOGGER 🧬
const log = (msg, type = 'INFO') => {
    const icons = { 'INFO': 'ℹ️', 'SUCCESS': '✅', 'ERROR': '❌', 'HYPE': '🔥' };
    console.log(`${icons[type] || '🤖'} [YT-Downloader]: ${msg}`);
};

const args = process.argv.slice(2);
let url = null;
let outputDir = process.cwd();

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[i + 1];
    if (args[i] === '--out') outputDir = args[i + 1];
}

if (!url) {
    log("Usage: node index.js --url <youtube_url> [--out <output_dir>]", 'ERROR');
    process.exit(1);
}

const main = async () => {
    try {
        log(`Analyzing video DNA... (${url})`);
        
        if (!ytdl.validateURL(url)) {
            throw new Error("Invalid YouTube URL. The cyber-police have been notified. (Just kidding, but check the link)");
        }

        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '_');
        
        // 🧬 GENETIC MUTATION: Hype Prefix
        const hypePrefix = "🔥_EVOLVED_";
        const filename = `${hypePrefix}${title}.mp4`;
        const outputPath = path.join(outputDir, filename);

        log(`Target acquired: "${info.videoDetails.title}"`, 'HYPE');
        log(`Initiating quantum transfer to: ${outputPath}`);

        const video = ytdl(url, { quality: 'highest' });
        
        video.pipe(fs.createWriteStream(outputPath));

        video.on('progress', (chunkLength, downloaded, total) => {
            const percent = downloaded / total;
            const barLength = 20;
            const filled = Math.round(percent * barLength);
            const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
            process.stdout.write(`\rDownloading: [${bar}] ${(percent * 100).toFixed(2)}%`);
        });

        video.on('end', () => {
            process.stdout.write('\n');
            log(`Download complete! The artifact has been secured.`, 'SUCCESS');
            console.log(JSON.stringify({
                status: 'success',
                path: outputPath,
                title: info.videoDetails.title
            }));
        });

        video.on('error', (err) => {
             log(`Stream error: ${err.message}`, 'ERROR');
             process.exit(1);
        });

    } catch (error) {
        log(`CRITICAL FAILURE: ${error.message}`, 'ERROR');
        process.exit(1);
    }
};

main();

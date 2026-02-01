const fs = require('fs');
const path = require('path');
const https = require('https');
const { program } = require('commander');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

program
  .option('--source <string>', 'Source Chat ID')
  .option('--limit <number>', 'Number of messages', 20)
  .option('--output <string>', 'Output HTML path', 'chat.html')
  .parse(process.argv);

const options = program.opts();

// Helper functions (same as chat-forwarder)
async function post(url, data, token) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }
        }, (res) => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject); req.write(JSON.stringify(data)); req.end();
    });
}
async function get(url, token) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject); req.end();
    });
}
async function getToken() { /* ... reuse token logic or just fetch ... */
    try { if (fs.existsSync(TOKEN_CACHE_FILE)) { const c = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE)); if (c.expire > Date.now()/1000+300) return c.token; } } catch(e){}
    const res = await post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: APP_ID, app_secret: APP_SECRET });
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token: res.tenant_access_token, expire: Date.now()/1000 + res.expire })); } catch(e){}
    return res.tenant_access_token;
}

function renderHTML(messages) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f5f6f7; padding: 20px; margin: 0; }
        .chat-container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: #3370ff; color: #fff; padding: 15px; text-align: center; font-weight: bold; font-size: 18px; }
        .message-list { padding: 20px; }
        .message { display: flex; margin-bottom: 15px; align-items: flex-start; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; background: #ccc; margin-right: 10px; flex-shrink: 0; overflow: hidden; }
        .avatar img { width: 100%; height: 100%; object-fit: cover; }
        .content { max-width: 80%; }
        .name { font-size: 12px; color: #888; margin-bottom: 4px; }
        .bubble { background: #f0f2f5; padding: 10px 15px; border-radius: 8px; font-size: 14px; color: #333; line-height: 1.5; word-wrap: break-word; }
        
        /* Privacy Protection */
        .blur-text { color: transparent; text-shadow: 0 0 8px rgba(0,0,0,0.5); }
        .blur-img { filter: blur(8px); }
        .privacy-mask { background: #e0e0e0; color: #888; border-radius: 4px; padding: 0 4px; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="header">Chat History (Privacy Protected)</div>
        <div class="message-list">
            ${messages.map(m => {
                // Determine content type
                let text = "Unsupported message type";
                try {
                    const content = JSON.parse(m.body.content);
                    if (m.msg_type === 'text') text = content.text;
                    else if (m.msg_type === 'post') text = content.content.map(p => p.map(e => e.text || '[Media]').join('')).join('\n');
                    else if (m.msg_type === 'image') text = '[Image]';
                    else if (m.msg_type === 'interactive') text = '[Card]';
                    else text = `[${m.msg_type}]`;
                } catch (e) {}

                // Mock avatar for now since we don't fetch user info individually to save time/api calls
                // In a real app we would fetch user info. Here we just blur the "idea" of an avatar.
                
                const isMe = false; // Simplified
                
                return `
                <div class="message">
                    <div class="avatar blur-img" style="background-color: #${(m.sender && m.sender.sender_id ? m.sender.sender_id : '000000').slice(-6)}"></div>
                    <div class="content">
                        <div class="name"><span class="privacy-mask">User ${(m.sender && m.sender.sender_id ? m.sender.sender_id : 'Unknown').slice(-4)}</span></div>
                        <div class="bubble">${text}</div>
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    </div>
</body>
</html>
    `;
}

async function main() {
    const token = await getToken();
    console.log(`Fetching messages from ${options.source}...`);
    const listUrl = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${options.source}&page_size=${options.limit}&sort_type=ByCreateTimeDesc`;
    const listRes = await get(listUrl, token);
    
    if (listRes.code !== 0) { console.error("Error:", listRes); process.exit(1); }
    
    // Reverse to chronological
    const messages = (listRes.data.items || []).reverse();
    
    console.log(`Rendering ${messages.length} messages to HTML...`);
    const html = renderHTML(messages);
    
    fs.writeFileSync(options.output, html);
    console.log(`HTML saved to ${options.output}`);
}

main();

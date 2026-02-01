const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { program } = require('commander');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

program
  .option('--image <string>', 'Image path')
  .option('--target <string>', 'Target ID')
  .parse(process.argv);

const options = program.opts();

async function post(url, data, token, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { 'Authorization': `Bearer ${token}` } : {}), ...headers }
        }, (res) => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject); 
        if (data instanceof Buffer) req.write(data);
        else req.write(JSON.stringify(data));
        req.end();
    });
}

// Token logic... (Copy-paste brevity)
async function getToken() {
    try { if (fs.existsSync(TOKEN_CACHE_FILE)) { const c = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE)); if (c.expire > Date.now()/1000+300) return c.token; } } catch(e){}
    const res = await new Promise((resolve, reject) => {
        const req = https.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: {'Content-Type': 'application/json'} }, r => { let b=''; r.on('data', c=>b+=c); r.on('end', ()=>resolve(JSON.parse(b))); });
        req.write(JSON.stringify({app_id:APP_ID, app_secret:APP_SECRET})); req.end();
    });
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token: res.tenant_access_token, expire: Date.now()/1000 + res.expire })); } catch(e){}
    return res.tenant_access_token;
}

async function uploadImage(token, filePath) {
    console.log(`Uploading ${filePath}...`);
    const fileContent = fs.readFileSync(filePath);
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    
    let body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${path.basename(filePath)}"\r\nContent-Type: image/png\r\n\r\n`),
        fileContent,
        Buffer.from(`\r\n--${boundary}--`)
    ]);

    const res = await post('https://open.feishu.cn/open-apis/im/v1/images', body, token, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
    });
    
    if (res.code !== 0) throw new Error(JSON.stringify(res));
    return res.data.image_key;
}

async function main() {
    const token = await getToken();
    const imageKey = await uploadImage(token, options.image);
    console.log(`Image uploaded: ${imageKey}`);
    
    let receiveIdType = 'open_id';
    if (options.target.startsWith('oc_')) receiveIdType = 'chat_id';
    
    const res = await post(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        receive_id: options.target,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey })
    }, token);
    
    if (res.code !== 0) console.error("Send failed:", res);
    else console.log("Image sent successfully!");
}

main();

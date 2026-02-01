const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Try to load .env from workspace root
try {
  const envPath = path.resolve(__dirname, '../../../.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
  } else {
    // Fallback or try standard load
    require('dotenv').config();
  }
} catch (e) {
  // ignore
}

// SHARED TOKEN CACHE (Unified with feishu-card)
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../../memory/feishu_token.json');

function loadConfig() {
  const configPath = path.join(__dirname, '../config.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error("Failed to parse config.json");
    }
  }
  
  return {
    app_id: process.env.FEISHU_APP_ID || config.app_id,
    app_secret: process.env.FEISHU_APP_SECRET || config.app_secret
  };
}

async function getTenantAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  // 1. Try Memory Cache (File)
  if (fs.existsSync(TOKEN_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      if (cached.token && cached.expire > now + 60) {
        return cached.token;
      }
    } catch (e) {
      // Ignore cache errors, fetch new
    }
  }

  const config = loadConfig();
  if (!config.app_id || !config.app_secret) {
    throw new Error("Missing app_id or app_secret. Please set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables.");
  }

  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      "app_id": config.app_id,
      "app_secret": config.app_secret
    })
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg}`);
  }

  // 2. Update Memory Cache (File)
  try {
    const cacheData = {
      token: data.tenant_access_token,
      expire: now + data.expire
    };
    // Ensure directory exists
    const cacheDir = path.dirname(TOKEN_CACHE_FILE);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cacheData, null, 2));
  } catch (e) {
    console.error("Failed to write token cache:", e.message);
  }

  return data.tenant_access_token;
}

module.exports = {
  getTenantAccessToken
};

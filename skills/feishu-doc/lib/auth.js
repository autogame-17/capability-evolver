const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Robust .env loading
const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../../../.env')
];

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    try {
      require('dotenv').config({ path: envPath });
      envLoaded = true;
      break;
    } catch (e) {
      // Ignore load error
    }
  }
}

let tokenCache = {
  token: null,
  expireTime: 0
};

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

const TOKEN_CACHE_FILE = path.join(__dirname, '../cache/token.json');

async function getTenantAccessToken() {
  const now = Date.now() / 1000;

  // Try to load from disk first
  if (!tokenCache.token && fs.existsSync(TOKEN_CACHE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      if (saved.token && saved.expireTime > now) {
        tokenCache = saved;
      }
    } catch (e) {
      // Ignore corrupted cache
    }
  }

  if (tokenCache.token && tokenCache.expireTime > now) {
    return tokenCache.token;
  }

  const config = loadConfig();
  if (!config.app_id || !config.app_secret) {
    throw new Error("Missing app_id or app_secret. Please set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables or create a config.json file.");
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "app_id": config.app_id,
          "app_secret": config.app_secret
        }),
        timeout: 5000 // 5s timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.code !== 0) {
        throw new Error(`Failed to get tenant_access_token: ${data.msg}`);
      }

      tokenCache.token = data.tenant_access_token;
      tokenCache.expireTime = now + data.expire - 60; // Refresh 1 minute early

      // Persist to disk
      try {
        const cacheDir = path.dirname(TOKEN_CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(tokenCache));
      } catch (e) {
        console.error("Failed to save token cache:", e.message);
      }

      return tokenCache.token;

    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Failed to retrieve access token after retries");
}

module.exports = {
  getTenantAccessToken
};

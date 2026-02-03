const fs = require('fs');
const path = require('path');

// This script checks Feishu-specific health requirements.
// It is called by the main evolver via INTEGRATION_STATUS_CMD.

function check() {
    const issues = [];
    const MEMORY_DIR = process.env.MEMORY_DIR || path.resolve(__dirname, '../../memory');

    // 1. Check App ID
    if (!process.env.FEISHU_APP_ID) {
        issues.push('Feishu App ID Missing');
    }

    // 2. Check Token Freshness
    try {
        const tokenPath = path.resolve(MEMORY_DIR, 'feishu_token.json');
        if (fs.existsSync(tokenPath)) {
            const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            // expire is in seconds, Date.now() is ms
            if (tokenData.expire < Date.now() / 1000) {
                issues.push('Feishu Token Expired');
            }
        } else {
            issues.push('Feishu Token Missing');
        }
    } catch (e) {
        issues.push(`Feishu Token Check Error: ${e.message}`);
    }

    // Output issues to stdout (will be captured by evolver)
    if (issues.length > 0) {
        console.log(issues.join(', '));
    }
}

check();
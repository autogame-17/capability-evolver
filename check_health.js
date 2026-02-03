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

    // 3. Check Temp Directory (Critical for Cards)
    const TEMP_DIR = path.resolve(__dirname, '../../temp');
    if (!fs.existsSync(TEMP_DIR)) {
        try { 
            fs.mkdirSync(TEMP_DIR); 
            // Fixed silently, do not report unless it fails
        } catch(e) { 
            issues.push('Temp Dir Missing & Cannot Create'); 
        }
    } else {
        try { fs.accessSync(TEMP_DIR, fs.constants.W_OK); }
        catch(e) { issues.push('Temp Dir Not Writable'); }
    }

    // 4. Log Hygiene (Auto-Cleanup Stale Error Logs)
    const ERROR_LOG = path.resolve(__dirname, '../private-evolver/evolution_error.log');
    if (fs.existsSync(ERROR_LOG)) {
        try {
            const stats = fs.statSync(ERROR_LOG);
            const now = Date.now();
            const ageHours = (now - stats.mtimeMs) / (1000 * 60 * 60);
            // If error log is > 24 hours old, delete it to avoid confusion in future alerts
            if (ageHours > 24) {
                fs.unlinkSync(ERROR_LOG);
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    // Output issues to stdout (will be captured by evolver)
    if (issues.length > 0) {
        console.log(issues.join(', '));
    }
}

check();
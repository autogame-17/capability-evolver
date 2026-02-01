const fs = require('fs');
// Mock event handler for Feishu Menu Events
// In a real scenario, this would be invoked by the Gateway webhook handler.

async function handle(eventPayload) {
    console.log("Received Feishu Event:", JSON.stringify(eventPayload));
    
    if (eventPayload.header.event_type === 'application.bot.menu_v6') {
        const userOpenId = eventPayload.sender.sender_id.open_id;
        const menuKey = eventPayload.event.event_key;
        
        console.log(`User ${userOpenId} clicked menu: ${menuKey}`);
        
        // Response logic
        // We can call send.js here
        const { execSync } = require('child_process');
        try {
            const replyText = `收到！你点击了菜单按钮：\`${menuKey}\` 喵！😺`;
            execSync(`node ${__dirname}/send.js --target "${userOpenId}" --text "${replyText}" --color "green"`);
        } catch (e) {
            console.error("Failed to send reply:", e);
        }
    }
}

// CLI adapter
if (require.main === module) {
    // Read from stdin or args
    const payload = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    handle(payload);
}

module.exports = { handle };

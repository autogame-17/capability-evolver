const fs = require('fs');
const path = require('path');
const { program } = require('commander');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const TOKEN_CACHE_FILE = path.resolve(__dirname, '../../memory/feishu_token.json');

if (!APP_ID || !APP_SECRET) {
    console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not set.');
    process.exit(1);
}

// Reuse getToken logic
async function getToken(forceRefresh = false) {
    try {
        if (!forceRefresh && fs.existsSync(TOKEN_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (cached.expire > now + 60) return cached.token;
        }
    } catch (e) {}

    if (forceRefresh) {
        try { if (fs.existsSync(TOKEN_CACHE_FILE)) fs.unlinkSync(TOKEN_CACHE_FILE); } catch(e) {}
    }

    try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
        });
        const data = await res.json();
        if (!data.tenant_access_token) throw new Error(`No token returned: ${JSON.stringify(data)}`);

        try {
            const cacheData = {
                token: data.tenant_access_token,
                expire: Math.floor(Date.now() / 1000) + data.expire 
            };
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cacheData, null, 2));
        } catch (e) {}

        return data.tenant_access_token;
    } catch (e) {
        console.error('Failed to get token:', e.message);
        process.exit(1);
    }
}

async function executeWithAuthRetry(operation) {
    let token = await getToken();
    try {
        return await operation(token);
    } catch (e) {
        const msg = e.message || '';
        const isAuthError = msg.includes('9999166') || 
                           (msg.toLowerCase().includes('token') && (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expire')));
        
        if (isAuthError) {
            console.error(`[Group-Intel] Auth Error (${msg}). Refreshing token...`);
            token = await getToken(true);
            return await operation(token);
        }
        throw e;
    }
}

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            return await res.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

program
    .name('group-intel-fetch')
    .description('Fetch Feishu group chat history for analysis');

program
    .command('list')
    .description('List active group chats the bot is in')
    .action(async () => {
        try {
            await executeWithAuthRetry(async (token) => {
                // Fetch chats (first page)
                const data = await fetchWithRetry('https://open.feishu.cn/open-apis/im/v1/chats?page_size=20', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                
                if (data.code !== 0) {
                     if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                        throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
                     }
                     throw new Error(JSON.stringify(data));
                }

                const chats = data.data.items || [];
                console.log(JSON.stringify(chats.map(c => ({
                    name: c.name,
                    chat_id: c.chat_id,
                    description: c.description
                })), null, 2));
            });
        } catch (e) {
            console.error('Error listing chats:', e.message);
        }
    });

program
    .command('history <chat_id>')
    .description('Fetch recent message history from a chat')
    .option('-l, --limit <number>', 'Number of messages', '20')
    .action(async (chatId, options) => {
        try {
            await executeWithAuthRetry(async (token) => {
                const allMessages = [];
                let pageToken = '';
                let remaining = parseInt(options.limit);
                
                while (remaining > 0) {
                    const pageSize = Math.min(remaining, 50);
                    let url = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${pageSize}&sort_type=ByCreateTimeDesc`;
                    if (pageToken) url += `&page_token=${pageToken}`;

                    const data = await fetchWithRetry(url, {
                        headers: { Authorization: `Bearer ${token}` }
                    });

                    if (data.code !== 0) {
                        // Check for Auth Error codes to trigger retry
                        if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                            throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
                        }
                        throw new Error(`API Error ${data.code}: ${data.msg}`);
                    }

                    const items = data.data.items || [];
                    if (items.length === 0) break;

                    allMessages.push(...items);
                    remaining -= items.length;
                    
                    if (data.data.has_more && data.data.page_token) {
                        pageToken = data.data.page_token;
                    } else {
                        break;
                    }
                }

                const messages = allMessages.map(m => {
                    let content = m.body.content;
                    try {
                        // Content is often a JSON string
                        content = JSON.parse(content);
                    } catch(e) {}
                    
                    let senderId = 'unknown';
                    if (m.sender && m.sender.sender_id) {
                         senderId = m.sender.sender_id.user_id || m.sender.sender_id.open_id || 'unknown';
                    }

                    return {
                        sender: senderId,
                        type: m.msg_type,
                        time: new Date(parseInt(m.create_time)).toISOString(),
                        content: content
                    };
                });
                
                // --- UPDATE START: Check for new messages ---
                const lastHistoryFile = path.resolve(__dirname, `history_last_check_${chatId}.json`);
                let lastCheckTime = 0;
                if (fs.existsSync(lastHistoryFile)) {
                    try {
                        const lastData = JSON.parse(fs.readFileSync(lastHistoryFile, 'utf8'));
                        lastCheckTime = new Date(lastData.lastTime).getTime();
                    } catch(e) {}
                }

                // Filter for messages NEWER than lastCheckTime
                const newMessages = messages.filter(m => new Date(m.time).getTime() > lastCheckTime);

                if (newMessages.length === 0) {
                    console.log("NO_NEW_MESSAGES"); // Special flag for the agent
                } else {
                    console.log(JSON.stringify(newMessages.reverse(), null, 2));
                    
                    // Update last check time to the newest message
                    const newestMsg = newMessages[newMessages.length - 1];
                    try {
                        fs.writeFileSync(lastHistoryFile, JSON.stringify({ lastTime: newestMsg.time }));
                    } catch(e) {}
                }
                 // --- UPDATE END ---
            });
        } catch (e) {
            console.error('Error fetching history:', e.message);
        }
    });

program
    .command('members <chat_id>')
    .description('List members of a chat')
    .action(async (chatId) => {
        try {
            await executeWithAuthRetry(async (token) => {
                const url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?member_id_type=open_id`;
                const data = await fetchWithRetry(url, {
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (data.code !== 0) {
                     if (data.code === 99991663 || data.code === 99991664 || data.code === 99991661) {
                        throw new Error(`Feishu Auth Error: ${data.code} ${data.msg}`);
                     }
                     throw new Error(JSON.stringify(data));
                }

                const members = (data.data.items || []).map(m => ({
                    name: m.name,
                    id: m.member_id,
                    type: m.member_id_type
                }));

                console.log(JSON.stringify(members, null, 2));
            });
        } catch (e) {
            console.error('Error fetching members:', e.message);
        }
    });

program.parse();

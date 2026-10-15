// Gửi thông báo admin qua Telegram bot. Mọi tin đều có tiêu đề [TIKTOK].
const chatCache = new Map();

async function api(token, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
}

// Bot không nhắn được theo username user → tra chat id từ getUpdates (admin phải /start bot trước).
// Username channel/group public thì dùng thẳng "@name".
async function resolveChatId(token, admin) {
    if (/^-?\d+$/.test(admin)) return admin;
    const name = admin.replace(/^@/, '').toLowerCase();
    if (chatCache.has(name)) return chatCache.get(name);

    const updates = await api(token, 'getUpdates').catch(() => []);
    for (const u of updates) {
        const chat = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member)?.chat;
        if (chat?.username?.toLowerCase() === name) {
            chatCache.set(name, chat.id);
            return chat.id;
        }
    }
    return `@${name}`;
}

export async function sendTelegram(cfg, text) {
    const token = cfg.telegramToken?.trim();
    const admin = cfg.telegramAdmin?.trim();
    if (!token || !admin) return false;
    await api(token, 'sendMessage', {chat_id: await resolveChatId(token, admin), text: `[TIKTOK]\n${text}`});
    return true;
}

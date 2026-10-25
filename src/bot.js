const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const appButton = () => ({
  inline_keyboard: [[{ text: '🕘 Табелни очиш', web_app: { url: `${WEBAPP_URL}/app/` } }]],
});

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text) return;
  if (msg.text.startsWith('/start')) {
    await api('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Ассалому алайкум! Ишга келганингиз ва кетганингизни белгилаш учун пастдаги тугмани босинг.',
      reply_markup: appButton(),
    });
  } else if (msg.text.startsWith('/id')) {
    await api('sendMessage', { chat_id: msg.chat.id, text: `Сизнинг chat ID: ${msg.chat.id}` });
  }
}

async function notifyAdmins(text) {
  if (!BOT_TOKEN) return;
  for (const chat_id of ADMIN_CHAT_IDS) {
    await api('sendMessage', { chat_id, text }).catch((e) => console.error('notify:', e.message));
  }
}

async function startBot() {
  if (!BOT_TOKEN) {
    console.log('BOT_TOKEN кўрсатилмаган — Telegram бот ишга туширилмади');
    return;
  }
  if (WEBAPP_URL.startsWith('https://')) {
    await api('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Табель', web_app: { url: `${WEBAPP_URL}/app/` } },
    }).catch((e) => console.error(e.message));
  } else {
    console.warn('WEBAPP_URL https:// билан бошланиши керак — Telegram Mini App фақат HTTPS да ишлайди');
  }
  await api('deleteWebhook').catch(() => {});
  console.log('Telegram бот ишга тушди (long polling)');

  let offset = 0;
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => console.error('bot:', e.message));
      }
    } catch (e) {
      console.error('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

module.exports = { startBot, notifyAdmins };

const crypto = require('node:crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEV_TELEGRAM_ID = process.env.DEV_TELEGRAM_ID; // фақат локал тест учун
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

function adminLogin(username, password) {
  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) return null;
  return sign({ role: 'admin', user: username, exp: Date.now() + TOKEN_TTL_MS });
}

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!verify(token)) return res.status(401).json({ error: 'Авторизация талаб қилинади' });
  next();
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData, maxAgeSec = 24 * 60 * 60) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !BOT_TOKEN) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqual(calc, hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  return JSON.parse(params.get('user') || 'null');
}

function requireTelegram(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  let user = initData ? validateInitData(initData) : null;
  if (!user && DEV_TELEGRAM_ID && !initData) {
    user = { id: Number(DEV_TELEGRAM_ID), first_name: 'Dev', username: 'dev' };
  }
  if (!user) return res.status(401).json({ error: 'Илова фақат Telegram орқали очилиши керак' });
  req.tgUser = user;
  next();
}

module.exports = { adminLogin, requireAdmin, requireTelegram };

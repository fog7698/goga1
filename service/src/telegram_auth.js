const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verify Telegram WebApp initData per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns the parsed `user` object on success, or null if missing/invalid/expired/token-not-set.
 */
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

/** Express middleware: verifies the `X-Telegram-Init-Data` header and attaches req.tgUser. */
function requireTelegram(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: 'telegram_auth_failed' });
  req.tgUser = user;
  next();
}

module.exports = { verifyInitData, requireTelegram };

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const db = require('./db');
const subs = require('./subscriptions');
const payments = require('./payments');
const xray = require('./xray');
const cases = require('./cases');
const media = require('./media');
const { happConnectLink, redirectLinks } = require('./connect_links');
const channelGate = require('./channel_gate');
const { requireTelegram } = require('./telegram_auth');
const { onSubscriptionsChanged } = require('./sync');

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_PASSWORD) {
  console.log(`[admin] No ADMIN_PASSWORD set - generated one for this boot: ${ADMIN_PASSWORD}`);
  console.log('[admin] Set ADMIN_PASSWORD as a Railway variable to keep it stable across restarts.');
}

// Ties the session token to the current ADMIN_PASSWORD (no separate secret to manage) - rotating
// the password automatically invalidates every previously issued session.
function adminSessionToken() {
  return crypto.createHash('sha256').update(`${ADMIN_PASSWORD}:tokyo-vpn-admin-session`).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Basic Auth still works (handy for curl/scripts); browsers get a real login page + session
// cookie instead, since Chrome's native Basic Auth prompt is prone to silent retry loops
// (ERR_TOO_MANY_RETRIES) once it has a stale saved credential for the origin.
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, encoded] = auth.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [, pass] = decoded.split(':');
  if (pass === ADMIN_PASSWORD) return next();

  const cookies = parseCookies(req);
  if (cookies.admin_session && cookies.admin_session === adminSessionToken()) return next();

  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    return res.redirect('/admin/login');
  }
  res.set('WWW-Authenticate', 'Basic realm="TOKYO VPN Admin"');
  return res.status(401).send('Unauthorized');
}

// xray's VLESS/XHTTP listener only binds 127.0.0.1 (see xray.js) - Railway's raw TCP Proxy
// silently drops this project's handshakes, so the tunnel rides in as ordinary-looking HTTP
// request/response bodies on this same public HTTPS port and gets forwarded to xray locally.
const tunnelProxy = httpProxy.createProxyServer({ target: { host: '127.0.0.1', port: 8444 } });
tunnelProxy.on('error', (err) => console.error('[tunnel-proxy] error:', err.message));

function createApp(botApi) {
  const app = express();

  // Registered first and matched on the raw path (not an Express route) so express.json() and
  // everything else below never touches the tunnel's request/response streams - xhttp streams
  // chunked binary bodies that must reach xray untouched, not get buffered by a body parser.
  app.use((req, res, next) => {
    if (!req.url.startsWith(xray.TUNNEL_PATH)) return next();
    tunnelProxy.web(req, res);
  });

  app.use(express.json());

  // Registered before the requireAdmin gate below, so the login page/endpoint stay reachable
  // without credentials.
  app.get('/admin/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'login.html')));
  app.post('/admin/login', (req, res) => {
    if (String(req.body?.password || '') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'wrong_password' });
    res.cookie('admin_session', adminSessionToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/admin',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });
  app.post('/admin/logout', (_req, res) => {
    res.clearCookie('admin_session', { path: '/admin' });
    res.json({ ok: true });
  });

  // Gate the whole /admin/* path (including its static HTML/JS) before any static file
  // serving touches it - otherwise express.static would hand out the admin page unauthenticated.
  app.use('/admin', requireAdmin, express.static(path.join(__dirname, '..', 'public', 'admin')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (_req, res) => res.send('ok'));

  // Per-subscriber subscription list (many aliased "locations", one real server). `uuid` may be
  // any of a subscription's up to MAX_DEVICES_PER_SUBSCRIPTION device uuids.
  app.get('/sub/:uuid', (req, res) => {
    const row = subs.subscriptionForDeviceUuid(req.params.uuid);
    if (!row && req.params.uuid !== xray.OWNER_UUID) return res.status(404).send('not found');
    const body = xray.subscriptionBase64(req.params.uuid, row?.expires_at);
    const expiryLabel = xray.formatExpiry(row?.expires_at);
    const titleText = 'TOKYO VPN \u{1F5FC}' + (expiryLabel ? ` · до ${expiryLabel}` : '');
    const title = Buffer.from(titleText, 'utf8').toString('base64');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Profile-Title', 'base64:' + title);
    res.set('Profile-Update-Interval', '12');
    res.send(body);
  });

  // Telegram inline buttons and the Mini App's tg.openLink both reject non-http(s) URLs, so
  // happ:// / vless:// links are handed out as a 302 through here instead of directly.
  app.get('/connect/:uuid/happ', async (req, res) => {
    const row = subs.subscriptionForDeviceUuid(req.params.uuid);
    if (!row && req.params.uuid !== xray.OWNER_UUID) return res.status(404).send('not found');
    if (!PUBLIC_URL) return res.status(503).send('not configured');
    const link = await happConnectLink(`${PUBLIC_URL}/sub/${req.params.uuid}`);
    res.redirect(302, link);
  });

  app.get('/connect/:uuid/incy', (req, res) => {
    const row = subs.subscriptionForDeviceUuid(req.params.uuid);
    if (!row && req.params.uuid !== xray.OWNER_UUID) return res.status(404).send('not found');
    res.redirect(302, xray.vlessLink(req.params.uuid, 'TokyoVPN'));
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      countries: xray.COUNTRY_COUNT,
      plans: subs.PLANS,
      trialDays: subs.TRIAL_DAYS,
      paymentsConfigured: payments.configured(),
      botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
      supportContact: process.env.SUPPORT_CONTACT || '@tokyo_vpn_support',
      upgradeMultipliers: subs.UPGRADE_MULTIPLIERS,
    });
  });

  app.post('/api/promo/check', (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND active = 1').get(code);
    if (!promo) return res.json({ valid: false });
    if (promo.max_uses != null && promo.used_count >= promo.max_uses) return res.json({ valid: false });
    res.json({ valid: true, kind: promo.kind, value: promo.value });
  });

  // YooKassa notifies us here; we re-check the real status with YooKassa before trusting it.
  app.post('/webhook/yookassa', async (req, res) => {
    res.sendStatus(200); // ack immediately, YooKassa retries on non-2xx
    try {
      const paymentId = req.body?.object?.id;
      if (!paymentId) return;
      const payment = await payments.fetchPaymentStatus(paymentId);
      if (!payment || payment.status !== 'succeeded') return;
      const row = db.prepare("SELECT * FROM payments WHERE yookassa_payment_id = ? AND status != 'succeeded'").get(paymentId);
      if (!row) return;
      db.prepare("UPDATE payments SET status = 'succeeded' WHERE yookassa_payment_id = ?").run(paymentId);

      if (payment.metadata?.gift === 'true') {
        const code = subs.completeGiftPurchase(row.user_id, row.plan, row.amount);
        if (botApi && process.env.TELEGRAM_BOT_USERNAME) {
          const giftLink = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=gift_${code}`;
          botApi
            .sendMessage(
              row.user_id,
              `🎁 Подарочная подписка «${subs.PLANS[row.plan].label}» готова!\n\nОтправьте эту ссылку другу — она активируется, как только он её откроет:\n${giftLink}`
            )
            .catch(() => {});
        }
        return;
      }

      const sub = subs.activatePaidPlan(row.user_id, row.plan, row.amount);
      onSubscriptionsChanged();
      const links = redirectLinks(sub.vless_uuid);
      if (botApi && links) {
        botApi
          .sendMessage(
            row.user_id,
            `✅ Оплата получена! Подписка «${subs.PLANS[row.plan].label}» активна до ${sub.expires_at} UTC.\n\nНачислено монет за кейсы: 🪙 ${subs.COINS_PER_PLAN[row.plan] || 0}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📲 Открыть в Happ', url: links.happ }],
                  [{ text: '📲 Открыть в INCY', url: links.incy }],
                ],
              },
            }
          )
          .catch(() => {});
      }
    } catch (e) {
      console.error('[webhook] error:', e);
    }
  });

  // --- Mini App API (Telegram initData auth) ---
  // The site itself IS the Telegram Mini App - "registration" is just verifying initData,
  // there is no separate username/password signup flow.
  function deviceConnectInfo(uuid) {
    if (!PUBLIC_URL) return { uuid, subscriptionUrl: null, happLink: null, vlessLink: null };
    const links = redirectLinks(uuid);
    return { uuid, subscriptionUrl: `${PUBLIC_URL}/sub/${uuid}`, happLink: links?.happ ?? null, vlessLink: links?.incy ?? null };
  }

  app.get('/api/app/me', requireTelegram, async (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const sub = subs.activeSubscription(user.id);
    let subscriptionUrl = null;
    let links = null;
    let devices = [];
    if (sub) {
      devices = subs.listDevices(sub.id).map((d) => ({ uuid: d.uuid, label: d.label, ...deviceConnectInfo(d.uuid) }));
      if (PUBLIC_URL) {
        subscriptionUrl = `${PUBLIC_URL}/sub/${sub.vless_uuid}`;
        links = redirectLinks(sub.vless_uuid);
      }
    }
    res.json({
      subscription: sub ? { plan: sub.plan, status: sub.status, expiresAt: sub.expires_at } : null,
      coins: subs.getCoins(user.id),
      trialAvailable: !user.trial_used,
      connect: { subscriptionUrl, happLink: links?.happ ?? null, vlessLink: links?.incy ?? null },
      devices: { list: devices, max: subs.MAX_DEVICES_PER_SUBSCRIPTION },
      referral: { code: user.referral_code },
    });
  });

  // Up to MAX_DEVICES_PER_SUBSCRIPTION separate VLESS uuids per subscription, one per device.
  app.post('/api/app/devices', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const sub = subs.activeSubscription(user.id);
    if (!sub) return res.status(400).json({ error: 'no_subscription' });
    const result = subs.addDevice(sub.id);
    if (result.error) return res.status(400).json({ error: result.error });
    onSubscriptionsChanged();
    res.json({ ok: true, device: { ...result.device, ...deviceConnectInfo(result.device.uuid) } });
  });

  app.delete('/api/app/devices/:uuid', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const sub = subs.activeSubscription(user.id);
    if (!sub) return res.status(400).json({ error: 'no_subscription' });
    const result = subs.removeDevice(sub.id, req.params.uuid);
    if (result.error) return res.status(400).json({ error: result.error });
    onSubscriptionsChanged();
    res.json({ ok: true });
  });

  app.post('/api/app/plan/:key/pay', requireTelegram, async (req, res) => {
    const key = req.params.key;
    if (!subs.PLANS[key]) return res.status(404).json({ error: 'not_found' });
    if (!payments.configured()) return res.status(503).json({ error: 'not_configured' });
    const user = subs.ensureUser(req.tgUser);
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createPayment(user.id, key, returnUrl);
    if (result.error) return res.status(502).json({ error: 'payment_failed' });
    res.json({ url: result.url });
  });

  // Same payment flow, but the webhook (metadata.gift) routes the result to a redeemable link
  // sent back to the payer via the bot, instead of activating the subscription for them.
  app.post('/api/app/plan/:key/gift', requireTelegram, async (req, res) => {
    const key = req.params.key;
    if (!subs.PLANS[key]) return res.status(404).json({ error: 'not_found' });
    if (!payments.configured()) return res.status(503).json({ error: 'not_configured' });
    const user = subs.ensureUser(req.tgUser);
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createPayment(user.id, key, returnUrl, { gift: 'true' });
    if (result.error) return res.status(502).json({ error: 'payment_failed' });
    res.json({ url: result.url });
  });

  app.post('/api/app/trial', requireTelegram, async (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    if (user.trial_used) return res.status(400).json({ error: 'used' });
    if (channelGate.enabled() && botApi && !(await channelGate.isSubscribed(botApi, user.id))) {
      return res.status(403).json({ error: 'channel_required', channelUrl: channelGate.channelUrl });
    }
    const result = subs.startTrial(user.id);
    if (result.error === 'used') return res.status(400).json({ error: 'used' });
    onSubscriptionsChanged();
    res.json({ ok: true, subscription: { plan: result.sub.plan, expiresAt: result.sub.expires_at } });
  });

  app.get('/api/app/cases', requireTelegram, (_req, res) => {
    res.json({ cases: cases.getCaseTypes() });
  });

  app.get('/api/app/referrals', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    res.json({
      stats: subs.referralStats(user.id),
      milestones: subs.REFERRAL_MILESTONES,
      commissionPercent: subs.REFERRAL_COMMISSION_PERCENT,
    });
  });

  app.get('/api/app/media', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    res.json({
      stats: media.mediaStats(user.id),
      milestones: media.MEDIA_MILESTONES,
      platforms: media.PLATFORMS,
      payoutPer100k: media.PAYOUT_USD_PER_100K_VIEWS,
      maxPerPlatform: media.MAX_ACCOUNTS_PER_PLATFORM,
    });
  });

  app.post('/api/app/media/accounts', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const { platform, url } = req.body || {};
    const result = media.addAccount(user.id, platform, url);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, account: result.account });
  });

  app.post('/api/app/cases/:key/open', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const result = cases.openCase(user.id, req.params.key);
    if (result.error === 'not_enough_coins') return res.status(400).json({ error: 'not_enough_coins' });
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({
      item: { title: result.item.title, kind: result.item.kind, value: result.item.value },
      coins: subs.getCoins(user.id),
    });
  });

  app.post('/api/app/upgrade', requireTelegram, (req, res) => {
    const multiplier = Number(req.body?.multiplier);
    const stakeType = req.body?.stakeType === 'coins' ? 'coins' : 'days';
    const stakeAmount = Number(req.body?.stakeAmount);
    const user = subs.ensureUser(req.tgUser);
    const result = subs.upgradeAttempt(user.id, multiplier, stakeType, stakeAmount);
    if (result.error) return res.status(400).json({ error: result.error });
    onSubscriptionsChanged();
    res.json(result);
  });

  // --- Admin API (Basic Auth) ---
  app.use('/admin/api', requireAdmin);

  app.get('/admin/api/users', (req, res) => {
    const rows = subs.searchUsers(req.query.q).map((u) => ({
      ...u,
      referral: subs.referralStats(u.id),
      media: media.mediaStats(u.id),
    }));
    res.json(rows);
  });

  app.post('/admin/api/users/:id/coins', (req, res) => {
    const userId = Number(req.params.id);
    const delta = Number(req.body?.delta);
    if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: 'bad_input' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const coins = subs.adjustCoins(userId, delta);
    res.json({ ok: true, coins });
  });

  app.post('/admin/api/users/:id/subscription', (req, res) => {
    const userId = Number(req.params.id);
    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days <= 0) return res.status(400).json({ error: 'bad_input' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const sub = subs.grantDays(userId, days, 'admin-grant');
    onSubscriptionsChanged();
    res.json({ ok: true, subscription: { plan: sub.plan, expiresAt: sub.expires_at } });
  });

  app.post('/admin/api/users/:id/referral-payout', (req, res) => {
    const userId = Number(req.params.id);
    const amount = Number(req.body?.amountRub);
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'bad_input' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const balanceRub = subs.recordReferralPayout(userId, amount);
    res.json({ ok: true, balanceRub });
  });

  app.post('/admin/api/users/:id/media-payout', (req, res) => {
    const userId = Number(req.params.id);
    const views = Number(req.body?.views);
    if (!Number.isInteger(views) || views <= 0) return res.status(400).json({ error: 'bad_input' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'not_found' });
    media.recordMediaPayout(userId, views);
    res.json({ ok: true });
  });

  app.get('/admin/api/media', (req, res) => {
    res.json(media.listAllAccounts(req.query.status));
  });

  app.post('/admin/api/media/:id/status', (req, res) => {
    const { status, note } = req.body || {};
    const result = media.setStatus(Number(req.params.id), status, note);
    if (result.error) return res.status(400).json(result);
    res.json({ ok: true, account: result.account });
  });

  app.post('/admin/api/media/:id/views', (req, res) => {
    const views = Number(req.body?.views);
    if (!Number.isInteger(views) || views < 0) return res.status(400).json({ error: 'bad_input' });
    res.json({ ok: true, account: media.setViews(Number(req.params.id), views) });
  });

  app.get('/admin/api/cases', (_req, res) => res.json(cases.getCaseTypes({ includeInactiveItems: true })));

  app.put('/admin/api/cases/:key', (req, res) => {
    const { title, costCoins, active } = req.body || {};
    db.prepare('UPDATE case_types SET title = COALESCE(?, title), cost_coins = COALESCE(?, cost_coins), active = COALESCE(?, active) WHERE key = ?').run(
      title ?? null,
      Number.isInteger(costCoins) ? costCoins : null,
      typeof active === 'boolean' ? (active ? 1 : 0) : null,
      req.params.key
    );
    res.json({ ok: true });
  });

  app.post('/admin/api/cases/:key/items', (req, res) => {
    const caseType = db.prepare('SELECT id FROM case_types WHERE key = ?').get(req.params.key);
    if (!caseType) return res.status(404).json({ error: 'not_found' });
    const { title, kind, value, weight } = req.body || {};
    if (!title || !['days', 'percent', 'coins'].includes(kind) || !Number.isInteger(value) || !Number.isInteger(weight)) {
      return res.status(400).json({ error: 'bad_input' });
    }
    db.prepare('INSERT INTO case_items (case_type_id, title, kind, value, weight) VALUES (?,?,?,?,?)').run(
      caseType.id,
      title,
      kind,
      value,
      weight
    );
    res.json({ ok: true });
  });

  app.put('/admin/api/cases/items/:id', (req, res) => {
    const { title, kind, value, weight, active } = req.body || {};
    db.prepare(
      `UPDATE case_items SET
         title = COALESCE(?, title), kind = COALESCE(?, kind), value = COALESCE(?, value),
         weight = COALESCE(?, weight), active = COALESCE(?, active)
       WHERE id = ?`
    ).run(
      title ?? null,
      kind && ['days', 'percent', 'coins'].includes(kind) ? kind : null,
      Number.isInteger(value) ? value : null,
      Number.isInteger(weight) ? weight : null,
      typeof active === 'boolean' ? (active ? 1 : 0) : null,
      req.params.id
    );
    res.json({ ok: true });
  });

  app.delete('/admin/api/cases/items/:id', (req, res) => {
    db.prepare('DELETE FROM case_items WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.get('/admin/api/overview', (_req, res) => {
    const active = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status='active' AND expires_at > datetime('now')").get().c;
    const revenue = db
      .prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='succeeded' AND created_at >= datetime('now','start of month')")
      .get().s;
    const newToday = db.prepare("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','start of day')").get().c;
    const promosUsed = db.prepare('SELECT COUNT(*) c FROM promo_redemptions').get().c;
    res.json({ active, revenue, newToday, promosUsed, paymentsConfigured: payments.configured() });
  });

  app.get('/admin/api/subscriptions', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.plan, s.status, s.expires_at, u.id as user_id, u.username
         FROM subscriptions s JOIN users u ON u.id = s.user_id
         ORDER BY s.created_at DESC LIMIT 200`
      )
      .all();
    res.json(rows);
  });

  app.post('/admin/api/subscriptions/:id/disable', (req, res) => {
    db.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    onSubscriptionsChanged();
    res.json({ ok: true });
  });

  app.get('/admin/api/promo-codes', (_req, res) => res.json(db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all()));

  app.post('/admin/api/promo-codes', (req, res) => {
    const { code, kind, value, maxUses } = req.body || {};
    if (!code || !['percent', 'days'].includes(kind) || !Number.isInteger(value)) {
      return res.status(400).json({ error: 'bad_input' });
    }
    db.prepare('INSERT INTO promo_codes (code, kind, value, max_uses) VALUES (?,?,?,?)').run(
      String(code).trim().toUpperCase(),
      kind,
      value,
      maxUses ?? null
    );
    res.json({ ok: true });
  });

  app.post('/admin/api/promo-codes/:code/toggle', (req, res) => {
    db.prepare('UPDATE promo_codes SET active = 1 - active WHERE code = ?').run(req.params.code);
    res.json({ ok: true });
  });

  app.get('/admin/api/payments', (_req, res) =>
    res.json(db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 100').all())
  );

  // Admin page itself is behind the same Basic Auth.
  app.get('/admin', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
  app.get('/admin/', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

  return app;
}

module.exports = { createApp };

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const subs = require('./subscriptions');
const payments = require('./payments');
const xray = require('./xray');
const cases = require('./cases');
const economy = require('./economy');
const skins = require('./skins');
const inventory = require('./inventory');
const media = require('./media');
const { happConnectLink, redirectLinks } = require('./connect_links');
const channelGate = require('./channel_gate');
const { requireTelegram } = require('./telegram_auth');
const { onSubscriptionsChanged } = require('./sync');

const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || '';
const PUBLIC_URL = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : '';
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
//
// Which path a GET request gets used to route on the `Accept` header containing 'text/html' -
// but some mobile/in-app browsers don't send that on top-level navigation, so they fell through
// to the raw 401 + WWW-Authenticate challenge and got the browser's own native Basic Auth popup
// instead of our styled /admin/login form (confusing - it looks like a totally different,
// unstyled "access denied" flow). Route on whether the request already carries an Authorization
// header instead: a plain GET with no credentials at all is always a normal visit -> our login
// page; the 401 challenge is reserved for requests that already attempted (wrong) Basic Auth.
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const [, encoded] = auth.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [, pass] = decoded.split(':');
  if (pass === ADMIN_PASSWORD) return next();

  const cookies = parseCookies(req);
  if (cookies.admin_session && cookies.admin_session === adminSessionToken()) return next();

  if (req.method === 'GET' && !auth) {
    return res.redirect('/admin/login');
  }
  res.set('WWW-Authenticate', 'Basic realm="TOKYO VPN Admin"');
  return res.status(401).send('Unauthorized');
}

function createApp(botApi) {
  const app = express();

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

  // Pulled periodically by the VPN VPS (not pushed from here) to know which client uuids xray
  // should accept - keeps the VPS from needing any inbound-reachable Railway endpoint or SSH key.
  const VPN_SYNC_SECRET = process.env.VPN_SYNC_SECRET;
  app.get('/internal/vpn-clients', (req, res) => {
    if (!VPN_SYNC_SECRET || req.get('X-Sync-Secret') !== VPN_SYNC_SECRET) return res.status(404).end();
    res.json({ owner: xray.OWNER_UUID, clients: subs.activeClientUuids() });
  });

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
      dayPriceRub: economy.getConfig().dayPriceRub,
      maxCustomDays: subs.MAX_CUSTOM_DAYS,
      upgradeSkinChanceMin: subs.UPGRADE_SKIN_CHANCE_MIN,
      upgradeSkinChanceMax: subs.UPGRADE_SKIN_CHANCE_MAX,
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

      const isCustomDays = row.plan === 'custom_days';
      const planLabel = isCustomDays ? `${row.days} дн.` : subs.PLANS[row.plan].label;

      if (payment.metadata?.gift === 'true') {
        const code = isCustomDays
          ? subs.completeGiftPurchaseDays(row.user_id, row.days, row.amount)
          : subs.completeGiftPurchase(row.user_id, row.plan, row.amount);
        if (botApi && process.env.TELEGRAM_BOT_USERNAME) {
          const giftLink = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=gift_${code}`;
          botApi
            .sendMessage(
              row.user_id,
              `🎁 Подарочная подписка «${planLabel}» готова!\n\nОтправьте эту ссылку другу — она активируется, как только он её откроет:\n${giftLink}`
            )
            .catch(() => {});
        }
        return;
      }

      const sub = isCustomDays
        ? subs.activateCustomDays(row.user_id, row.days, row.amount)
        : subs.activatePaidPlan(row.user_id, row.plan, row.amount);
      onSubscriptionsChanged();
      const links = redirectLinks(sub.vless_uuid);
      if (botApi && links) {
        botApi
          .sendMessage(
            row.user_id,
            `✅ Оплата получена! Подписка «${planLabel}» активна до ${sub.expires_at} UTC.\n\nНачислено монет за кейсы: 🪙 ${subs.COINS_PER_PLAN[row.plan] || 0}`,
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

  // Arbitrary-day purchase/gift (1..MAX_CUSTOM_DAYS) at the configurable per-day rate, alongside
  // the fixed PLANS tiers above.
  function validCustomDays(raw) {
    const days = Math.round(Number(raw));
    return Number.isFinite(days) && days >= 1 && days <= subs.MAX_CUSTOM_DAYS ? days : null;
  }

  app.post('/api/app/days/pay', requireTelegram, async (req, res) => {
    const days = validCustomDays(req.body?.days);
    if (!days) return res.status(400).json({ error: 'bad_days' });
    if (!payments.configured()) return res.status(503).json({ error: 'not_configured' });
    const user = subs.ensureUser(req.tgUser);
    const { amount } = subs.priceForDays(days, user.id);
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createCustomPayment(user.id, days, amount, returnUrl);
    if (result.error) return res.status(502).json({ error: 'payment_failed' });
    res.json({ url: result.url });
  });

  app.post('/api/app/days/gift', requireTelegram, async (req, res) => {
    const days = validCustomDays(req.body?.days);
    if (!days) return res.status(400).json({ error: 'bad_days' });
    if (!payments.configured()) return res.status(503).json({ error: 'not_configured' });
    const user = subs.ensureUser(req.tgUser);
    const { amount } = subs.priceForDays(days, user.id);
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createCustomPayment(user.id, days, amount, returnUrl, { gift: 'true' });
    if (result.error) return res.status(502).json({ error: 'payment_failed' });
    res.json({ url: result.url });
  });

  // Steam trade link, shown on the Profile subpage - required before a withdrawal request can be
  // created (inventory.requestWithdrawal).
  app.put('/api/app/profile', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const url = String(req.body?.steamTradeUrl || '').trim();
    if (url && !/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/.+/.test(url)) {
      return res.status(400).json({ error: 'bad_trade_url' });
    }
    db.prepare('UPDATE users SET steam_trade_url = ? WHERE id = ?').run(url || null, user.id);
    res.json({ ok: true, steamTradeUrl: url || null });
  });

  app.get('/api/app/inventory', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    res.json({ items: inventory.listInventory(user.id), steamTradeUrl: user.steam_trade_url || null });
  });

  app.post('/api/app/inventory/:id/sell', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const result = inventory.sellForDays(user.id, Number(req.params.id));
    if (result.error) return res.status(400).json({ error: result.error });
    onSubscriptionsChanged();
    res.json({ ok: true, days: result.days });
  });

  app.post('/api/app/inventory/:id/withdraw', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);
    const result = inventory.requestWithdrawal(user.id, Number(req.params.id));
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // Read-only skin catalog for the upgrade tab's "choose a target" picker.
  app.get('/api/app/skins', requireTelegram, (_req, res) => {
    res.json({ skins: skins.listSkins().filter((s) => s.available_for_upgrade) });
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
    if (result.error === 'not_enough_coins' || result.error === 'not_enough_days') {
      return res.status(400).json({ error: result.error });
    }
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({
      item: {
        title: result.item.title,
        kind: result.item.kind,
        value: result.item.value,
        imageUrl: result.item.imageUrl ?? null,
      },
      coins: subs.getCoins(user.id),
      inventoryId: result.inventoryId ?? null,
    });
  });

  // Fixed-multiplier mode (existing) vs. skin-targeting mode (stake days or a skin from your
  // inventory at one specific, more valuable skin) - selected by whether `targetSkinId` is sent.
  app.post('/api/app/upgrade', requireTelegram, (req, res) => {
    const user = subs.ensureUser(req.tgUser);

    if (req.body?.targetSkinId != null) {
      const stakeType = req.body?.stakeType === 'skin' ? 'skin' : 'days';
      const result = subs.upgradeToSkin(user.id, {
        stakeType,
        stakeAmount: req.body?.stakeAmount,
        stakeInventoryId: req.body?.stakeInventoryId,
        targetSkinId: req.body?.targetSkinId,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      onSubscriptionsChanged();
      return res.json(result);
    }

    const multiplier = Number(req.body?.multiplier);
    const stakeType = req.body?.stakeType === 'coins' ? 'coins' : 'days';
    const stakeAmount = Number(req.body?.stakeAmount);
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

  app.post('/admin/api/cases', (req, res) => {
    const { key, title, currency, costCoins, costDays } = req.body || {};
    const cur = currency === 'days' ? 'days' : 'coins';
    if (!key || !/^[a-z0-9_]+$/.test(key) || !title) return res.status(400).json({ error: 'bad_input' });
    if (cur === 'days' && !Number.isInteger(costDays)) return res.status(400).json({ error: 'bad_input' });
    if (cur === 'coins' && !Number.isInteger(costCoins)) return res.status(400).json({ error: 'bad_input' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM case_types').get().m || 0) + 1;
    try {
      db.prepare('INSERT INTO case_types (key, title, cost_coins, sort_order, currency, cost_days) VALUES (?,?,?,?,?,?)').run(
        key,
        title,
        cur === 'coins' ? costCoins : 0,
        nextOrder,
        cur,
        cur === 'days' ? costDays : null
      );
    } catch {
      return res.status(400).json({ error: 'key_taken' });
    }
    res.json({ ok: true });
  });

  app.put('/admin/api/cases/:key', (req, res) => {
    const { title, costCoins, costDays, active } = req.body || {};
    db.prepare(
      `UPDATE case_types SET
         title = COALESCE(?, title), cost_coins = COALESCE(?, cost_coins),
         cost_days = COALESCE(?, cost_days), active = COALESCE(?, active)
       WHERE key = ?`
    ).run(
      title ?? null,
      Number.isInteger(costCoins) ? costCoins : null,
      Number.isInteger(costDays) ? costDays : null,
      typeof active === 'boolean' ? (active ? 1 : 0) : null,
      req.params.key
    );
    res.json({ ok: true });
  });

  const MAX_ITEMS_PER_CASE = 30;
  // Day-priced cases only pay out in CS2 skins, priced 10%-100x the case's own RUB cost.
  function skinPriceInBand(skinPriceRub, costRub) {
    return skinPriceRub >= costRub * 0.1 && skinPriceRub <= costRub * 100;
  }

  app.post('/admin/api/cases/:key/items', (req, res) => {
    const caseType = db.prepare('SELECT * FROM case_types WHERE key = ?').get(req.params.key);
    if (!caseType) return res.status(404).json({ error: 'not_found' });
    const itemCount = db.prepare('SELECT COUNT(*) c FROM case_items WHERE case_type_id = ?').get(caseType.id).c;
    if (itemCount >= MAX_ITEMS_PER_CASE) return res.status(400).json({ error: 'case_full' });

    const { title, kind, value, weight, skinId, quantity } = req.body || {};
    if (!Number.isInteger(weight) || weight < 0) return res.status(400).json({ error: 'bad_input' });

    if (kind === 'skin') {
      const skin = skinId != null ? skins.getSkin(Number(skinId)) : null;
      if (!skin) return res.status(400).json({ error: 'bad_skin' });
      if (caseType.currency === 'days') {
        const costRub = caseType.cost_days * economy.getConfig().dayPriceRub;
        if (!skinPriceInBand(skin.price_rub, costRub)) return res.status(400).json({ error: 'price_out_of_band' });
      }
      db.prepare('INSERT INTO case_items (case_type_id, title, kind, value, weight, skin_id, quantity) VALUES (?,?,\'skin\',0,?,?,?)').run(
        caseType.id,
        skin.display_name,
        weight,
        skin.id,
        Number.isInteger(quantity) ? quantity : null
      );
      return res.json({ ok: true });
    }

    if (!title || !['days', 'percent', 'coins'].includes(kind) || !Number.isInteger(value)) {
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
    const { title, kind, value, weight, active, skinId, quantity } = req.body || {};
    const item = db.prepare('SELECT * FROM case_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });

    if (skinId != null) {
      const skin = skins.getSkin(Number(skinId));
      if (!skin) return res.status(400).json({ error: 'bad_skin' });
      const caseType = db.prepare('SELECT * FROM case_types WHERE id = ?').get(item.case_type_id);
      if (caseType.currency === 'days') {
        const costRub = caseType.cost_days * economy.getConfig().dayPriceRub;
        if (!skinPriceInBand(skin.price_rub, costRub)) return res.status(400).json({ error: 'price_out_of_band' });
      }
      db.prepare('UPDATE case_items SET skin_id = ?, title = ? WHERE id = ?').run(skin.id, skin.display_name, req.params.id);
    }

    db.prepare(
      `UPDATE case_items SET
         title = COALESCE(?, title), kind = COALESCE(?, kind), value = COALESCE(?, value),
         weight = COALESCE(?, weight), active = COALESCE(?, active), quantity = COALESCE(?, quantity)
       WHERE id = ?`
    ).run(
      skinId == null ? (title ?? null) : null,
      kind && ['days', 'percent', 'coins', 'skin'].includes(kind) ? kind : null,
      Number.isInteger(value) ? value : null,
      Number.isInteger(weight) ? weight : null,
      typeof active === 'boolean' ? (active ? 1 : 0) : null,
      Number.isInteger(quantity) ? quantity : null,
      req.params.id
    );
    res.json({ ok: true });
  });

  app.delete('/admin/api/cases/items/:id', (req, res) => {
    db.prepare('DELETE FROM case_items WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // --- Economy (skin prize balance) ---

  app.get('/admin/api/economy', (_req, res) => {
    res.json({
      balanceRub: economy.getSiteBalance(),
      totalDepositsRub: economy.getTotalDeposits(),
      maxPositivePayoutRub: economy.getMaxPositivePayoutRub(),
      activeSpinners: economy.getActiveSpinnerCount(economy.getConfig().activeWindowHours),
      config: economy.getConfig(),
    });
  });

  app.put('/admin/api/economy', (req, res) => {
    const { balanceRub, marginTargetPercent, payoutShareFactor, activeWindowHours, dayPriceRub } = req.body || {};
    if (balanceRub != null) economy.setSiteBalance(balanceRub);
    economy.updateConfig({ marginTargetPercent, payoutShareFactor, activeWindowHours, dayPriceRub });
    res.json({
      balanceRub: economy.getSiteBalance(),
      totalDepositsRub: economy.getTotalDeposits(),
      maxPositivePayoutRub: economy.getMaxPositivePayoutRub(),
      activeSpinners: economy.getActiveSpinnerCount(economy.getConfig().activeWindowHours),
      config: economy.getConfig(),
    });
  });

  // --- Skin catalog ---

  app.get('/admin/api/skins', (_req, res) => res.json(skins.listSkins()));

  app.post('/admin/api/skins', (req, res) => {
    const { marketHashName, displayName, imageUrl, priceRub } = req.body || {};
    if (!marketHashName) return res.status(400).json({ error: 'bad_input' });
    try {
      res.json({ ok: true, skin: skins.createSkin({ marketHashName, displayName, imageUrl, priceRub }) });
    } catch {
      res.status(400).json({ error: 'name_taken' });
    }
  });

  app.put('/admin/api/skins/:id', (req, res) => {
    const { displayName, imageUrl, priceRub, availableForUpgrade, marketHashName } = req.body || {};
    try {
      res.json({
        ok: true,
        skin: skins.updateSkin(Number(req.params.id), {
          displayName,
          imageUrl,
          priceRub: priceRub != null ? Number(priceRub) : undefined,
          availableForUpgrade,
          marketHashName,
        }),
      });
    } catch {
      res.status(400).json({ error: 'name_taken' });
    }
  });

  app.delete('/admin/api/skins/:id', (req, res) => {
    skins.deleteSkin(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/admin/api/skins/:id/refresh-price', async (req, res) => {
    const result = await skins.refreshSkinPrice(Number(req.params.id));
    if (result.error) return res.status(502).json(result);
    res.json({ ok: true, skin: result.skin });
  });

  // Walks the whole catalog in the background (rate-limit-safe delay between items) - starts and
  // returns immediately rather than blocking the request for the several minutes a full pass
  // takes; poll GET .../refresh-all for progress.
  app.post('/admin/api/skins/refresh-all', (_req, res) => {
    const result = skins.refreshAllSkins();
    if (result.error) return res.status(409).json(result);
    res.json(result);
  });

  app.get('/admin/api/skins/refresh-all', (_req, res) => res.json(skins.getBulkRefreshState()));

  // Per-skin case membership (add/remove from one case at a time), so the Скины catalog can
  // control "which cases include this skin" directly instead of only from inside each case's own
  // editor. Idempotent: adding an already-included skin or removing an absent one is a no-op.
  app.put('/admin/api/cases/:key/skin/:skinId', (req, res) => {
    const caseType = db.prepare('SELECT * FROM case_types WHERE key = ?').get(req.params.key);
    if (!caseType) return res.status(404).json({ error: 'not_found' });
    const skin = skins.getSkin(Number(req.params.skinId));
    if (!skin) return res.status(404).json({ error: 'bad_skin' });
    const existing = db.prepare('SELECT * FROM case_items WHERE case_type_id = ? AND skin_id = ?').get(caseType.id, skin.id);
    if (existing) return res.json({ ok: true, id: existing.id });
    const itemCount = db.prepare('SELECT COUNT(*) c FROM case_items WHERE case_type_id = ?').get(caseType.id).c;
    if (itemCount >= MAX_ITEMS_PER_CASE) return res.status(400).json({ error: 'case_full' });
    if (caseType.currency === 'days') {
      const costRub = caseType.cost_days * economy.getConfig().dayPriceRub;
      if (!skinPriceInBand(skin.price_rub, costRub)) return res.status(400).json({ error: 'price_out_of_band' });
    }
    const info = db
      .prepare("INSERT INTO case_items (case_type_id, title, kind, value, weight, skin_id) VALUES (?,?,'skin',0,10,?)")
      .run(caseType.id, skin.display_name, skin.id);
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  app.delete('/admin/api/cases/:key/skin/:skinId', (req, res) => {
    const caseType = db.prepare('SELECT id FROM case_types WHERE key = ?').get(req.params.key);
    if (!caseType) return res.status(404).json({ error: 'not_found' });
    db.prepare('DELETE FROM case_items WHERE case_type_id = ? AND skin_id = ?').run(caseType.id, Number(req.params.skinId));
    res.json({ ok: true });
  });

  // --- Steam withdrawal queue ---

  app.get('/admin/api/withdrawals', (req, res) => res.json(inventory.listWithdrawals(req.query.status)));

  app.post('/admin/api/withdrawals/:id/complete', (req, res) => {
    const result = inventory.completeWithdrawal(Number(req.params.id), req.body?.note);
    if (result.error) return res.status(404).json(result);
    res.json({ ok: true });
  });

  app.post('/admin/api/withdrawals/:id/reject', (req, res) => {
    const result = inventory.rejectWithdrawal(Number(req.params.id), req.body?.note);
    if (result.error) return res.status(404).json(result);
    res.json({ ok: true });
  });

  app.get('/admin/api/overview', (_req, res) => {
    const active = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status='active' AND expires_at > datetime('now')").get().c;
    const revenue = db
      .prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='succeeded' AND created_at >= datetime('now','start of month')")
      .get().s;
    const newToday = db.prepare("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','start of day')").get().c;
    const promosUsed = db.prepare('SELECT COUNT(*) c FROM promo_redemptions').get().c;
    res.json({ active, revenue, newToday, promosUsed, totalUsers: subs.totalUsers(), paymentsConfigured: payments.configured() });
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
    res.json(
      db
        .prepare(
          `SELECT p.*, u.username FROM payments p LEFT JOIN users u ON u.id = p.user_id
           ORDER BY p.created_at DESC LIMIT 300`
        )
        .all()
    )
  );

  // Admin page itself is behind the same Basic Auth.
  app.get('/admin', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
  app.get('/admin/', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

  return app;
}

module.exports = { createApp };

const crypto = require('crypto');
const db = require('./db');
const economy = require('./economy');
const skinsMod = require('./skins');

const PLANS = {
  '1m': { label: '1 месяц', days: 30, price: 75 },
  '6m': { label: '6 месяцев', days: 182, price: 320 },
  '12m': { label: '12 месяцев', days: 365, price: 550 },
};
const TRIAL_DAYS = 3;
const COINS_PER_PLAN = { '1m': 1, '6m': 6, '12m': 12 };
const MAX_DEVICES_PER_SUBSCRIPTION = 3;
// Arbitrary-day purchase/gift ceiling (see priceForDays) - 50000 days is ~137 years, plenty of
// headroom while still bounding the size of a single YooKassa payment.
const MAX_CUSTOM_DAYS = 50000;

// Круг апгрейдера: multiplier -> displayed win chance percent. Higher multiplier, lower chance.
// The realized RNG chance and the win-streak cap below are published in full at /fair-play.html,
// linked from the upgrade tab - see upgradeWinStreak/upgradeAttempt.
const UPGRADE_MULTIPLIERS = { 2: 42, 5: 16, 12: 6 };
const UPGRADE_REAL_CHANCE_FACTOR = 0.6;
const UPGRADE_MAX_WIN_STREAK = 3;
// Skin-targeting upgrade mode (stake days or a skin from your inventory at a specific, more
// valuable skin instead of a fixed multiplier) - displayed chance is the plain stake/target value
// ratio, clamped to this range; same UPGRADE_REAL_CHANCE_FACTOR discount and win-streak cap apply.
const UPGRADE_SKIN_CHANCE_MIN = 1;
const UPGRADE_SKIN_CHANCE_MAX = 85;

function genUuid() {
  return crypto.randomUUID();
}

function ensureUser(tgUser, referredByCode) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  if (existing) {
    if (tgUser.username && tgUser.username !== existing.username) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(tgUser.username, tgUser.id);
    }
    return existing;
  }
  let referredBy = null;
  if (referredByCode) {
    const ref = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referredByCode);
    if (ref && ref.id !== tgUser.id) referredBy = ref.id;
  }
  const referralCode = crypto.randomBytes(4).toString('hex');
  db.prepare(
    'INSERT INTO users (id, username, referral_code, referred_by) VALUES (?,?,?,?)'
  ).run(tgUser.id, tgUser.username || null, referralCode, referredBy);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
}

function activeSubscription(userId) {
  return db
    .prepare(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1"
    )
    .get(userId);
}

/** Create or extend the user's subscription by `days`, issuing a VLESS uuid if needed. */
function grantDays(userId, days, plan) {
  const existing = activeSubscription(userId);
  if (existing) {
    const newExpiry = `datetime(expires_at, '+${days} days')`;
    db.prepare(`UPDATE subscriptions SET expires_at = ${newExpiry}, plan = ? WHERE id = ?`).run(
      plan,
      existing.id
    );
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
  }
  const uuid = genUuid();
  const info = db
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, status, vless_uuid, expires_at) VALUES (?,?,?,?, datetime('now', '+${days} days'))`
    )
    .run(userId, plan, 'active', uuid);
  db.prepare('INSERT INTO subscription_devices (subscription_id, uuid, label) VALUES (?,?,?)').run(
    info.lastInsertRowid,
    uuid,
    'Устройство 1'
  );
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(info.lastInsertRowid);
}

/** Atomically deduct `days` from the user's active subscription (used to pay for a day-priced
 * case or upgrade stake) - fails without changes if they don't have that many days left. Mirrors
 * spendCoins's guarded-UPDATE pattern so a double-spend race can't leave expires_at negative. */
function spendDays(userId, days) {
  const info = db
    .prepare(
      `UPDATE subscriptions SET expires_at = datetime(expires_at, '-' || ? || ' days')
       WHERE user_id = ? AND status = 'active' AND datetime(expires_at, '-' || ? || ' days') > datetime('now')`
    )
    .run(days, userId, days);
  return info.changes > 0;
}

/** Up to MAX_DEVICES_PER_SUBSCRIPTION separate VLESS uuids per subscription, so one purchase can
 * cover several devices without sharing a single uuid. */
function listDevices(subscriptionId) {
  return db
    .prepare('SELECT * FROM subscription_devices WHERE subscription_id = ? ORDER BY id')
    .all(subscriptionId);
}

function addDevice(subscriptionId) {
  const devices = listDevices(subscriptionId);
  if (devices.length >= MAX_DEVICES_PER_SUBSCRIPTION) return { error: 'limit' };
  const uuid = genUuid();
  const label = `Устройство ${devices.length + 1}`;
  db.prepare('INSERT INTO subscription_devices (subscription_id, uuid, label) VALUES (?,?,?)').run(
    subscriptionId,
    uuid,
    label
  );
  return { device: { uuid, label } };
}

/** Refuses to remove the last remaining device - a subscription always needs at least one uuid. */
function removeDevice(subscriptionId, uuid) {
  const devices = listDevices(subscriptionId);
  if (devices.length <= 1) return { error: 'last_device' };
  if (!devices.some((d) => d.uuid === uuid)) return { error: 'not_found' };
  db.prepare('DELETE FROM subscription_devices WHERE subscription_id = ? AND uuid = ?').run(subscriptionId, uuid);
  return { ok: true };
}

/** The active subscription (if any) that owns `uuid` as one of its devices - used to resolve
 * incoming /sub and /connect requests for any of a subscription's up-to-3 device uuids. */
function subscriptionForDeviceUuid(uuid) {
  return db
    .prepare(
      `SELECT s.* FROM subscriptions s
       JOIN subscription_devices d ON d.subscription_id = s.id
       WHERE d.uuid = ? AND s.status = 'active' AND s.expires_at > datetime('now')`
    )
    .get(uuid);
}

/** Whole days left until `expiresAt` (SQL UTC datetime string), rounded up, floored at 1. */
function daysUntil(expiresAt) {
  const ms = new Date(String(expiresAt).replace(' ', 'T') + 'Z').getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 86400000));
}

/** Consecutive successful upgrade_attempts rows for a user, most recent first, capped at `cap`
 * rows (that's all a streak check ever needs). See /fair-play.html for why this exists. */
function upgradeWinStreak(userId, cap) {
  const rows = db
    .prepare('SELECT success FROM upgrade_attempts WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, cap);
  let streak = 0;
  for (const row of rows) {
    if (!row.success) break;
    streak++;
  }
  return streak;
}

/** Stake `stakeAmount` of the user's days or coins on one spin of the upgrade gauge at
 * `multiplier`. Win pays out stakeAmount * multiplier in the same currency staked; loss forfeits
 * the staked amount. Realized odds and the win-streak cap are published at /fair-play.html. */
function upgradeAttempt(userId, multiplier, stakeType, rawStakeAmount) {
  const displayedChance = UPGRADE_MULTIPLIERS[multiplier];
  if (!displayedChance) return { error: 'bad_multiplier' };
  if (stakeType !== 'days' && stakeType !== 'coins') return { error: 'bad_stake_type' };

  const sub = stakeType === 'days' ? activeSubscription(userId) : null;
  if (stakeType === 'days' && !sub) return { error: 'no_subscription' };
  const available = stakeType === 'days' ? daysUntil(sub.expires_at) : getCoins(userId);

  const stakeAmount = Math.round(Number(rawStakeAmount));
  if (!Number.isFinite(stakeAmount) || stakeAmount < 1 || stakeAmount > available) {
    return { error: 'bad_stake_amount' };
  }

  const forcedLoss = upgradeWinStreak(userId, UPGRADE_MAX_WIN_STREAK) >= UPGRADE_MAX_WIN_STREAK;
  const realChance = displayedChance * UPGRADE_REAL_CHANCE_FACTOR;
  const win = !forcedLoss && Math.random() * 100 < realChance;
  const resultAmount = stakeAmount * multiplier;

  let daysAfter = null;
  let coinsAfter = null;
  if (stakeType === 'days') {
    const deltaDays = win ? resultAmount - stakeAmount : -stakeAmount;
    const newExpiry =
      deltaDays >= 0
        ? `datetime(expires_at, '+${deltaDays} days')`
        : `MAX(datetime(expires_at, '${deltaDays} days'), datetime('now'))`;
    db.prepare(`UPDATE subscriptions SET expires_at = ${newExpiry}, plan = 'upgrade' WHERE id = ?`).run(sub.id);
    daysAfter = daysUntil(db.prepare('SELECT expires_at FROM subscriptions WHERE id = ?').get(sub.id).expires_at);
  } else {
    if (win) addCoins(userId, resultAmount - stakeAmount);
    else spendCoins(userId, stakeAmount);
    coinsAfter = getCoins(userId);
  }

  db.prepare(
    'INSERT INTO upgrade_attempts (user_id, multiplier, chance_percent, days_staked, success, days_after, stake_type, stake_amount, coins_after) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(userId, multiplier, displayedChance, stakeType === 'days' ? stakeAmount : 0, win ? 1 : 0, daysAfter, stakeType, stakeAmount, coinsAfter);

  return { win, multiplier, chance: displayedChance, stakeType, stakeAmount, resultAmount, daysAfter, coinsAfter };
}

/** Skin-targeting upgrade: stake either days or a skin already sitting in the inventory, aiming
 * at one specific (more valuable) skin instead of a fixed multiplier. Displayed chance is just
 * the stake/target value ratio (clamped to [UPGRADE_SKIN_CHANCE_MIN, UPGRADE_SKIN_CHANCE_MAX]);
 * the realized chance applies the same UPGRADE_REAL_CHANCE_FACTOR discount and win-streak cap as
 * the multiplier mode (see /fair-play.html), plus a balance gate: a win that would pay out more
 * than economy.getMaxPositivePayoutRub() above the stake never happens, however the dice land -
 * that's what stops the site being forced to hand out a skin it can't afford. */
function upgradeToSkin(userId, { stakeType, stakeAmount, stakeInventoryId, targetSkinId }) {
  const target = skinsMod.getSkin(Number(targetSkinId));
  if (!target || !target.available_for_upgrade) return { error: 'bad_target' };

  let stakeValueRub;
  let stakeDaysAmount = 0;
  let stakeInvRow = null;
  if (stakeType === 'days') {
    const sub = activeSubscription(userId);
    if (!sub) return { error: 'no_subscription' };
    const available = daysUntil(sub.expires_at);
    stakeDaysAmount = Math.round(Number(stakeAmount));
    if (!Number.isFinite(stakeDaysAmount) || stakeDaysAmount < 1 || stakeDaysAmount > available) {
      return { error: 'bad_stake_amount' };
    }
    stakeValueRub = stakeDaysAmount * economy.getConfig().dayPriceRub;
  } else if (stakeType === 'skin') {
    stakeInvRow = db
      .prepare("SELECT * FROM user_inventory WHERE id = ? AND user_id = ? AND status = 'owned'")
      .get(Number(stakeInventoryId), userId);
    if (!stakeInvRow) return { error: 'bad_stake_skin' };
    stakeValueRub = skinsMod.getSkin(stakeInvRow.skin_id)?.price_rub || 0;
  } else {
    return { error: 'bad_stake_type' };
  }
  if (!(target.price_rub > stakeValueRub)) return { error: 'target_not_higher' };

  const rawChance = (stakeValueRub / target.price_rub) * 100;
  const displayedChance = Math.min(UPGRADE_SKIN_CHANCE_MAX, Math.max(UPGRADE_SKIN_CHANCE_MIN, rawChance));
  const forcedLoss = upgradeWinStreak(userId, UPGRADE_MAX_WIN_STREAK) >= UPGRADE_MAX_WIN_STREAK;
  const netPayout = target.price_rub - stakeValueRub;
  const balanceGated = netPayout > economy.getMaxPositivePayoutRub();
  const realChance = displayedChance * UPGRADE_REAL_CHANCE_FACTOR;
  const win = !forcedLoss && !balanceGated && Math.random() * 100 < realChance;

  if (stakeType === 'days') {
    if (!spendDays(userId, stakeDaysAmount)) return { error: 'bad_stake_amount' };
  } else {
    db.prepare("UPDATE user_inventory SET status = 'sold', updated_at = datetime('now') WHERE id = ?").run(stakeInvRow.id);
  }

  let wonInventoryId = null;
  if (win) {
    wonInventoryId = db
      .prepare("INSERT INTO user_inventory (user_id, skin_id, source, price_rub_at_win) VALUES (?,?, 'upgrade', ?)")
      .run(userId, target.id, target.price_rub).lastInsertRowid;
  }
  economy.applySpinResult(stakeValueRub, win ? target.price_rub : 0);

  db.prepare(
    `INSERT INTO upgrade_attempts
       (user_id, multiplier, chance_percent, days_staked, success, days_after, stake_type, stake_amount, coins_after, stake_skin_id, target_skin_id)
     VALUES (?,0,?,?,?,NULL,?,?,NULL,?,?)`
  ).run(
    userId,
    Math.round(displayedChance),
    stakeType === 'days' ? stakeDaysAmount : 0,
    win ? 1 : 0,
    stakeType,
    stakeType === 'days' ? stakeDaysAmount : 0,
    stakeInvRow ? stakeInvRow.skin_id : null,
    target.id
  );

  return { win, chance: Math.round(displayedChance * 100) / 100, stakeType, targetSkin: target, wonInventoryId };
}

function startTrial(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user.trial_used) return { error: 'used' };
  db.prepare('UPDATE users SET trial_used = 1 WHERE id = ?').run(userId);
  const sub = grantDays(userId, TRIAL_DAYS, 'trial');
  return { sub };
}

function redeemPromo(userId, rawCode) {
  const code = rawCode.trim().toUpperCase();
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND active = 1').get(code);
  if (!promo) return { error: 'not_found' };
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) return { error: 'exhausted' };
  const already = db.prepare('SELECT 1 FROM promo_redemptions WHERE code = ? AND user_id = ?').get(code, userId);
  if (already) return { error: 'already_used' };

  db.prepare('INSERT INTO promo_redemptions (code, user_id) VALUES (?,?)').run(code, userId);
  db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(code);

  if (promo.kind === 'days') {
    const sub = grantDays(userId, promo.value, activeSubscription(userId)?.plan || 'promo');
    return { kind: 'days', value: promo.value, sub };
  }
  // percent: stored for the next payment
  db.prepare('UPDATE users SET promo_pending_percent = ? WHERE id = ?').run(promo.value, userId);
  return { kind: 'percent', value: promo.value };
}

/** All-time credit for coins - independent of case_openings spend log. */
function addCoins(userId, amount) {
  if (amount <= 0) return;
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, userId);
}

function getCoins(userId) {
  return db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)?.coins || 0;
}

/** Admin grant/deduct - unlike addCoins this allows negative deltas, clamped so the balance never goes below 0. */
function adjustCoins(userId, delta) {
  db.prepare('UPDATE users SET coins = max(0, coins + ?) WHERE id = ?').run(delta, userId);
  return getCoins(userId);
}

/** Admin lookup: exact id match, or a username substring search. */
/** No query - the most recently registered users (what the admin panel shows by default).
 * Otherwise an exact id match or a username substring search. */
function searchUsers(query) {
  const q = String(query || '').trim().replace(/^@/, '');
  const rows = !q
    ? db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200').all()
    : /^\d+$/.test(q)
      ? db.prepare('SELECT * FROM users WHERE id = ?').all(Number(q))
      : db.prepare('SELECT * FROM users WHERE username LIKE ? ORDER BY created_at DESC LIMIT 25').all(`%${q}%`);
  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    coins: u.coins,
    trialUsed: !!u.trial_used,
    createdAt: u.created_at,
    subscription: activeSubscription(u.id),
  }));
}

/** Total users ever registered (pressed /start at least once) - the admin overview headline. */
function totalUsers() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}

/** Atomically deduct coins if the user has enough; returns false without changes otherwise. */
function spendCoins(userId, amount) {
  const info = db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?').run(amount, userId, amount);
  return info.changes > 0;
}

const REFERRAL_COMMISSION_PERCENT = 20;

// Paying-referral-count milestones - a one-time cash-or-item choice, paid out via support once
// unlocked (same manual-withdrawal flow as the % earnings below).
const REFERRAL_MILESTONES = [
  { count: 100, cashRub: 3500, prize: '★ Тычковые ножи | Чистая вода (После полевых испытаний) в CS2', image: '/prizes/knife-bright-water.png' },
  { count: 500, cashRub: 20000, prize: 'Игровой компьютер', icon: 'pc' },
  { count: 5000, cashRub: 100000, prize: 'Последний iPhone', image: '/prizes/iphone.jpg' },
  { count: 10000, cashRub: 200000, prize: 'Rolex', image: '/prizes/rolex.jpg' },
];

/** Everything a successful payment earns the PAYER, regardless of who the subscription itself
 * ends up going to: case-opening coins, clearing a spent promo discount, the referrer's one-time
 * first-payment bonus, and the referrer's 20% lifetime revenue share. Split out from granting the
 * subscription days so a gift purchase (days go to the recipient, not the payer) can still credit
 * these to the payer. */
function creditPurchasePerks(payerUserId, planKey, amountRub) {
  db.prepare('UPDATE users SET promo_pending_percent = NULL WHERE id = ?').run(payerUserId);
  addCoins(payerUserId, COINS_PER_PLAN[planKey] || 0);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payerUserId);
  if (user.referred_by) {
    const alreadyRewarded = db
      .prepare('SELECT 1 FROM referral_rewards WHERE referrer_id = ? AND referred_id = ?')
      .get(user.referred_by, payerUserId);
    if (!alreadyRewarded) {
      const bonusDays = 7;
      grantDays(user.referred_by, bonusDays, 'referral-bonus');
      db.prepare(
        'INSERT INTO referral_rewards (referrer_id, referred_id, days_granted) VALUES (?,?,?)'
      ).run(user.referred_by, payerUserId, bonusDays);
    }

    if (Number.isFinite(amountRub) && amountRub > 0) {
      const commission = Math.round((amountRub * REFERRAL_COMMISSION_PERCENT) / 100);
      if (commission > 0) {
        db.prepare('UPDATE users SET referral_earned_rub = referral_earned_rub + ? WHERE id = ?').run(
          commission,
          user.referred_by
        );
      }
    }
  }
}

/** After a successful normal (non-gift) payment: extend the payer's own subscription plus
 * everything creditPurchasePerks covers. */
function activatePaidPlan(userId, planKey, amountRub) {
  const plan = PLANS[planKey];
  const sub = grantDays(userId, plan.days, planKey);
  creditPurchasePerks(userId, planKey, amountRub);
  return sub;
}

/** After a successful GIFT payment: the payer keeps the usual purchase perks (coins, referral
 * effects) but the subscription itself does not activate yet - it waits as a one-time redeemable
 * code until whoever receives the link opens it in the bot. */
function completeGiftPurchase(payerUserId, planKey, amountRub) {
  creditPurchasePerks(payerUserId, planKey, amountRub);
  const plan = PLANS[planKey];
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO gift_codes (code, plan, days, purchased_by) VALUES (?,?,?,?)').run(
    code,
    planKey,
    plan.days,
    payerUserId
  );
  return code;
}

/** Same as activatePaidPlan but for an arbitrary day count (priceForDays) instead of a fixed
 * PLANS tier - no case-opening coins (those are tied to the fixed tiers), everything else the
 * same: extends the payer's subscription, clears any pending promo discount, pays the referrer. */
function activateCustomDays(userId, days, amountRub) {
  const sub = grantDays(userId, days, 'custom_days');
  creditPurchasePerks(userId, 'custom_days', amountRub);
  return sub;
}

/** Same as completeGiftPurchase but for an arbitrary day count - redeemGiftCode already reads
 * `days` generically off the gift_codes row, so no change needed there. */
function completeGiftPurchaseDays(payerUserId, days, amountRub) {
  creditPurchasePerks(payerUserId, 'custom_days', amountRub);
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO gift_codes (code, plan, days, purchased_by) VALUES (?,?,?,?)').run(
    code,
    'custom_days',
    days,
    payerUserId
  );
  return code;
}

/** Redeem a gift code for whoever opens the link - one-time use. */
function redeemGiftCode(code, userId) {
  const gift = db.prepare('SELECT * FROM gift_codes WHERE code = ?').get(code);
  if (!gift) return { error: 'not_found' };
  if (gift.redeemed_by) return { error: 'already_redeemed' };
  db.prepare("UPDATE gift_codes SET redeemed_by = ?, redeemed_at = datetime('now') WHERE code = ?").run(userId, code);
  const sub = grantDays(userId, gift.days, gift.plan);
  return { sub, purchasedBy: gift.purchased_by };
}

/** Referrals who have made at least one successful payment - what the milestone bar counts. */
function payingReferralCount(userId) {
  return db
    .prepare(
      `SELECT COUNT(*) c FROM users u
       WHERE u.referred_by = ? AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'succeeded')`
    )
    .get(userId).c;
}

function referralStats(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const payingCount = payingReferralCount(userId);
  const nextMilestone = REFERRAL_MILESTONES.find((m) => m.count > payingCount) || null;
  const prevThreshold = REFERRAL_MILESTONES.filter((m) => m.count <= payingCount).pop();
  return {
    balanceRub: user.referral_earned_rub - user.referral_paid_rub,
    payingReferrals: payingCount,
    nextMilestone,
    milestonesReached: REFERRAL_MILESTONES.filter((m) => m.count <= payingCount),
    progressBase: prevThreshold ? prevThreshold.count : 0,
  };
}

/** Admin: record a manual payout (support already paid the user outside the app) and reduce the balance. */
function recordReferralPayout(userId, amountRub) {
  db.prepare('UPDATE users SET referral_paid_rub = referral_paid_rub + ? WHERE id = ?').run(amountRub, userId);
  const user = db.prepare('SELECT referral_earned_rub, referral_paid_rub FROM users WHERE id = ?').get(userId);
  return user.referral_earned_rub - user.referral_paid_rub;
}

/** Linear price for an arbitrary day count at the configurable per-day rate (site_config
 * `day_price_rub`, default 2.5₽), with the same pending-promo-percent discount as priceForPlan. */
function priceForDays(days, userId) {
  const dayPriceRub = economy.getConfig().dayPriceRub;
  const base = Math.round(days * dayPriceRub * 100) / 100;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user && user.promo_pending_percent) {
    const discounted = Math.max(0.01, Math.round(((base * (100 - user.promo_pending_percent)) / 100) * 100) / 100);
    return { amount: discounted, original: base, percent: user.promo_pending_percent };
  }
  return { amount: base, original: base, percent: 0 };
}

function priceForPlan(planKey, userId) {
  const plan = PLANS[planKey];
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user && user.promo_pending_percent) {
    const discounted = Math.max(1, Math.round((plan.price * (100 - user.promo_pending_percent)) / 100));
    return { amount: discounted, original: plan.price, percent: user.promo_pending_percent };
  }
  return { amount: plan.price, original: plan.price, percent: 0 };
}

/** All currently-active (non-expired) VLESS client uuids across every device slot, owner excluded
 * (xray.js adds the owner itself). */
function activeClientUuids() {
  return db
    .prepare(
      `SELECT d.uuid FROM subscription_devices d
       JOIN subscriptions s ON s.id = d.subscription_id
       WHERE s.status = 'active' AND s.expires_at > datetime('now')`
    )
    .all()
    .map((r) => r.uuid);
}

/** Mark newly-expired subscriptions; returns true if the active client set changed. */
function sweepExpired() {
  const info = db
    .prepare("UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at <= datetime('now')")
    .run();
  return info.changes > 0;
}

module.exports = {
  PLANS,
  TRIAL_DAYS,
  COINS_PER_PLAN,
  UPGRADE_MULTIPLIERS,
  MAX_DEVICES_PER_SUBSCRIPTION,
  MAX_CUSTOM_DAYS,
  UPGRADE_SKIN_CHANCE_MIN,
  UPGRADE_SKIN_CHANCE_MAX,
  ensureUser,
  activeSubscription,
  grantDays,
  spendDays,
  daysUntil,
  upgradeAttempt,
  upgradeToSkin,
  startTrial,
  redeemPromo,
  activatePaidPlan,
  activateCustomDays,
  priceForPlan,
  priceForDays,
  activeClientUuids,
  listDevices,
  addDevice,
  removeDevice,
  subscriptionForDeviceUuid,
  sweepExpired,
  totalUsers,
  addCoins,
  getCoins,
  spendCoins,
  adjustCoins,
  searchUsers,
  REFERRAL_COMMISSION_PERCENT,
  REFERRAL_MILESTONES,
  referralStats,
  recordReferralPayout,
  completeGiftPurchase,
  completeGiftPurchaseDays,
  redeemGiftCode,
};

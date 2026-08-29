const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bloom.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,           -- telegram user id
  username TEXT,
  referral_code TEXT UNIQUE NOT NULL,
  referred_by INTEGER REFERENCES users(id),
  trial_used INTEGER NOT NULL DEFAULT 0,
  promo_pending_percent INTEGER,    -- discount % to apply on next payment
  coins INTEGER NOT NULL DEFAULT 0, -- case-opening currency, earned on paid purchases
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,               -- trial | 1m | 6m | 12m
  status TEXT NOT NULL,             -- active | expired | cancelled
  vless_uuid TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Up to MAX_DEVICES_PER_SUBSCRIPTION (subscriptions.js) rows per subscription - each is a
-- separate VLESS uuid so a subscriber can hand out one link per device instead of sharing one.
CREATE TABLE IF NOT EXISTS subscription_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  uuid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- percent | days
  value INTEGER NOT NULL,
  max_uses INTEGER,                 -- NULL = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referred_id INTEGER NOT NULL,
  days_granted INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan TEXT NOT NULL,
  amount INTEGER NOT NULL,          -- RUB
  yookassa_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | canceled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS case_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,         -- case_1 | case_6 | case_12
  title TEXT NOT NULL,
  cost_coins INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS case_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_type_id INTEGER NOT NULL REFERENCES case_types(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,               -- days | percent | coins
  value INTEGER NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1, -- relative drop weight, shown to admin as %
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS case_openings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  case_type_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One spin of the subscription-upgrade gauge: stakes a chosen amount of days or coins on a
-- multiplier. See subscriptions.upgradeAttempt for the resolution logic and /fair-play.html for
-- the published odds/streak terms.
CREATE TABLE IF NOT EXISTS upgrade_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  multiplier INTEGER NOT NULL,
  chance_percent INTEGER NOT NULL,
  days_staked INTEGER NOT NULL,
  success INTEGER NOT NULL,
  days_after INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Social-media accounts submitted for the "media referral" program. Views are entered by an
-- admin after manually checking the account (see media.js docblock for why - no legitimate way
-- to auto-scrape Instagram/TikTok, and no YouTube API key configured).
CREATE TABLE IF NOT EXISTS gift_codes (
  code TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  days INTEGER NOT NULL,
  purchased_by INTEGER NOT NULL,
  redeemed_by INTEGER,
  redeemed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,           -- youtube | instagram | tiktok
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  views INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple key/value store for the skin-payout economy (site balance + tuning knobs) - see
-- economy.js. A row per setting rather than a singleton row so new knobs can be added without
-- another migration.
CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Shared CS:GO/CS2 skin catalog, referenced by case_items (day-priced cases) and user_inventory.
-- price_rub is normally refreshed from the Steam Community Market priceoverview endpoint by an
-- admin action (skins.refreshSkinPrice) but can also be edited by hand as a reliable fallback.
CREATE TABLE IF NOT EXISTS skins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_hash_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  image_url TEXT,
  price_rub REAL NOT NULL DEFAULT 0,
  price_updated_at TEXT,
  available_for_upgrade INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A skin a user has won from a day-priced case or the upgrader, pending a decision: keep, sell
-- back for subscription days, or request a Steam trade withdrawal (see inventory.js).
CREATE TABLE IF NOT EXISTS user_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  skin_id INTEGER NOT NULL REFERENCES skins(id),
  source TEXT NOT NULL,              -- case | upgrade
  price_rub_at_win REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'owned', -- owned | sold | withdraw_pending | withdrawn
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Steam trade withdrawal queue - fulfilled manually by an admin (no Steam bot/API credentials
-- are configured), see inventory.requestWithdrawal and the admin "Заявки на вывод" panel.
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL REFERENCES user_inventory(id),
  steam_trade_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | rejected
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the initial release - migrate existing DBs in place.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('coins')) {
  db.exec('ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('referral_earned_rub')) {
  // Lifetime 20% revenue-share balance from a referral's payments (RUB), reduced by admin payouts.
  db.exec('ALTER TABLE users ADD COLUMN referral_earned_rub INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN referral_paid_rub INTEGER NOT NULL DEFAULT 0');
  // Media-views baseline already paid out (weekly $ payout is derived from views past this mark).
  db.exec('ALTER TABLE users ADD COLUMN media_views_paid_baseline INTEGER NOT NULL DEFAULT 0');
}

// Upgrade gauge: the player can now stake a chosen amount of either days or coins (previously
// always the whole subscription), see /fair-play.html for the published odds/streak terms.
const upgradeAttemptCols = db.prepare('PRAGMA table_info(upgrade_attempts)').all().map((c) => c.name);
if (!upgradeAttemptCols.includes('stake_type')) {
  db.exec("ALTER TABLE upgrade_attempts ADD COLUMN stake_type TEXT NOT NULL DEFAULT 'days'");
  db.exec('ALTER TABLE upgrade_attempts ADD COLUMN stake_amount INTEGER');
  db.exec('ALTER TABLE upgrade_attempts ADD COLUMN coins_after INTEGER');
}
// Skin-targeted upgrade attempts (stake a skin from the inventory and/or target a specific skin
// instead of a fixed days/coins multiplier) - see subscriptions.upgradeAttempt.
if (!upgradeAttemptCols.includes('stake_skin_id')) {
  db.exec('ALTER TABLE upgrade_attempts ADD COLUMN stake_skin_id INTEGER');
  db.exec('ALTER TABLE upgrade_attempts ADD COLUMN target_skin_id INTEGER');
}

// Cases can now cost VPN days instead of coins, with skin-only prizes (day-priced cases) - see
// cases.openCase / economy.js. cost_coins stays NOT NULL so it's set to 0 for currency='days'.
const caseTypeCols = db.prepare('PRAGMA table_info(case_types)').all().map((c) => c.name);
if (!caseTypeCols.includes('currency')) {
  db.exec("ALTER TABLE case_types ADD COLUMN currency TEXT NOT NULL DEFAULT 'coins'");
  db.exec('ALTER TABLE case_types ADD COLUMN cost_days INTEGER');
}
const caseItemCols = db.prepare('PRAGMA table_info(case_items)').all().map((c) => c.name);
if (!caseItemCols.includes('skin_id')) {
  db.exec('ALTER TABLE case_items ADD COLUMN skin_id INTEGER REFERENCES skins(id)');
  db.exec('ALTER TABLE case_items ADD COLUMN quantity INTEGER'); // NULL = unlimited stock
}
const caseOpeningCols = db.prepare('PRAGMA table_info(case_openings)').all().map((c) => c.name);
if (!caseOpeningCols.includes('cost_rub')) {
  db.exec('ALTER TABLE case_openings ADD COLUMN cost_rub REAL');
  db.exec('ALTER TABLE case_openings ADD COLUMN payout_rub REAL');
}

// Steam trade link, set from the Mini App profile page - required before a withdrawal request
// can be created (inventory.requestWithdrawal).
if (!userCols.includes('steam_trade_url')) {
  db.exec('ALTER TABLE users ADD COLUMN steam_trade_url TEXT');
}

// Arbitrary-day purchases (see subscriptions.priceForDays) are logged with plan='custom_days' and
// need the day count on hand for the webhook to know how many days to grant.
const paymentCols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
if (!paymentCols.includes('days')) {
  db.exec('ALTER TABLE payments ADD COLUMN days INTEGER');
}

// Backfill: every pre-existing subscription becomes device 1 in subscription_devices.
db.exec(`
  INSERT INTO subscription_devices (subscription_id, uuid, label)
  SELECT s.id, s.vless_uuid, 'Устройство 1'
  FROM subscriptions s
  WHERE NOT EXISTS (SELECT 1 FROM subscription_devices d WHERE d.subscription_id = s.id)
`);

// Seed the three default case tiers (1 / 6 / 12 coins) with starter prizes on first boot only -
// after that the admin panel owns their contents and drop weights.
if (db.prepare('SELECT COUNT(*) c FROM case_types').get().c === 0) {
  const insertCase = db.prepare('INSERT INTO case_types (key, title, cost_coins, sort_order) VALUES (?,?,?,?)');
  const insertItem = db.prepare(
    'INSERT INTO case_items (case_type_id, title, kind, value, weight) VALUES (?,?,?,?,?)'
  );
  const c1 = insertCase.run('case_1', 'Кейс · 1 монета', 1, 1).lastInsertRowid;
  insertItem.run(c1, '+3 дня подписки', 'days', 3, 60);
  insertItem.run(c1, '+7 дней подписки', 'days', 7, 30);
  insertItem.run(c1, '+1 монета обратно', 'coins', 1, 10);

  const c6 = insertCase.run('case_6', 'Кейс · 6 монет', 6, 2).lastInsertRowid;
  insertItem.run(c6, '+14 дней подписки', 'days', 14, 45);
  insertItem.run(c6, '+30 дней подписки', 'days', 30, 25);
  insertItem.run(c6, 'Скидка 10% на оплату', 'percent', 10, 25);
  insertItem.run(c6, '+3 монеты обратно', 'coins', 3, 5);

  const c12 = insertCase.run('case_12', 'Кейс · 12 монет', 12, 3).lastInsertRowid;
  insertItem.run(c12, '+30 дней подписки', 'days', 30, 40);
  insertItem.run(c12, '+90 дней подписки', 'days', 90, 15);
  insertItem.run(c12, 'Скидка 20% на оплату', 'percent', 20, 30);
  insertItem.run(c12, '+6 монет обратно', 'coins', 6, 15);
}

// Default economy knobs - INSERT OR IGNORE so an admin's saved values survive a redeploy.
const defaultConfig = {
  skin_prize_balance_rub: '0',
  margin_target_percent: '20',
  payout_share_factor: '0.8',
  active_window_hours: '24',
  day_price_rub: '2.5',
};
const insertConfig = db.prepare('INSERT OR IGNORE INTO site_config (key, value) VALUES (?,?)');
for (const [key, value] of Object.entries(defaultConfig)) insertConfig.run(key, value);

// Seed the 5 default day-priced skin cases (10/30/90/180/360 days) with a starter CS2 skin pool
// on first boot only - after that the admin panel (Скины/Кейсы) owns the catalog, prices and
// drop weights. Each case gets 30 items: 13 partial-loss (priced below the case's cost - the
// user still gets something worth 10-95% of what they paid), 14 mid wins (1x-80x cost) and 3
// jackpots (~100x cost), matching the required 10%-100x price band. Prices here are rough
// placeholders sized off the multiplier, not live Steam data - use "Обновить цену" in /admin
// after launch to replace them with real Steam Market prices.
if (db.prepare("SELECT COUNT(*) c FROM case_types WHERE currency = 'days'").get().c === 0) {
  const DAY_PRICE_RUB = 2.5;
  const DAY_CASES = [
    { key: 'days_10', title: 'Кейс · 10 дней', costDays: 10 },
    { key: 'days_30', title: 'Кейс · 30 дней', costDays: 30 },
    { key: 'days_90', title: 'Кейс · 90 дней', costDays: 90 },
    { key: 'days_180', title: 'Кейс · 180 дней', costDays: 180 },
    { key: 'days_360', title: 'Кейс · 360 дней', costDays: 360 },
  ];
  const WEARS = ['Battle-Scarred', 'Well-Worn', 'Field-Tested', 'Minimal Wear', 'Factory New'];
  // 30 real CS2 skin families, ordered cheapest-feel to most expensive - index maps 1:1 to the
  // multiplier/weight arrays below (loss[0-12], mid[13-26], jackpot[27-29]).
  const SKIN_FAMILIES = [
    'P250 | Sand Dune', 'MP9 | Storm', 'Glock-18 | Sand Dune', 'Nova | Predator',
    'Five-SeveN | Copper Galaxy', 'MAC-10 | Indigo', 'UMP-45 | Riot', 'Tec-9 | Blue Titanium',
    'P90 | Asiimov', 'Sawed-Off | Wasteland Rebel', 'Galil AR | Chatterbox', 'FAMAS | Roll Cage',
    'SCAR-20 | Cyrex',
    'SSG 08 | Blood in the Water', 'MP7 | Nemesis', 'Desert Eagle | Blaze', 'USP-S | Kill Confirmed',
    'M4A1-S | Hyper Beast', 'AK-47 | Redline', 'AWP | Electric Hive', 'M4A4 | Neo-Noir',
    'AK-47 | Vulcan', 'AWP | Asiimov', 'Glock-18 | Fade', 'AK-47 | Fire Serpent', 'M4A4 | Howl',
    'AWP | Dragon Lore',
    '★ Karambit | Doppler', '★ Butterfly Knife | Fade', '★ Sport Gloves | Vice',
  ];
  const LOSS_MULTS = [0.12, 0.18, 0.22, 0.28, 0.33, 0.40, 0.45, 0.52, 0.60, 0.68, 0.75, 0.85, 0.95];
  const MID_MULTS = [1.3, 1.8, 2.5, 3.5, 5, 7, 10, 14, 19, 25, 33, 45, 60, 80];
  const JACKPOT_MULTS = [100, 100, 100];
  const MULTS = [...LOSS_MULTS, ...MID_MULTS, ...JACKPOT_MULTS];
  const LOSS_WEIGHT = 60;
  const MID_WEIGHTS = [40, 32, 26, 20, 15, 11, 8, 6, 4, 3, 2, 2, 1, 1];
  const JACKPOT_WEIGHT = 1;
  const WEIGHTS = [...MULTS.slice(0, 13).map(() => LOSS_WEIGHT), ...MID_WEIGHTS, JACKPOT_WEIGHT, JACKPOT_WEIGHT, JACKPOT_WEIGHT];

  const insertDayCase = db.prepare(
    'INSERT INTO case_types (key, title, cost_coins, sort_order, currency, cost_days) VALUES (?,?,0,?,?,?)'
  );
  const insertSkin = db.prepare(
    'INSERT INTO skins (market_hash_name, display_name, price_rub, price_updated_at) VALUES (?,?,?,datetime(\'now\'))'
  );
  const insertDayItem = db.prepare(
    'INSERT INTO case_items (case_type_id, title, kind, value, weight, skin_id) VALUES (?,?,\'skin\',0,?,?)'
  );

  DAY_CASES.forEach((def, ci) => {
    const costRub = def.costDays * DAY_PRICE_RUB;
    const caseTypeId = insertDayCase.run(def.key, def.title, 4 + ci, 'days', def.costDays).lastInsertRowid;
    const wear = WEARS[ci];
    SKIN_FAMILIES.forEach((family, i) => {
      const marketHashName = `${family} (${wear})`;
      const priceRub = Math.round(MULTS[i] * costRub * 100) / 100;
      const skinId = insertSkin.run(marketHashName, marketHashName, priceRub).lastInsertRowid;
      insertDayItem.run(caseTypeId, marketHashName, WEIGHTS[i], skinId);
    });
  });
}

module.exports = db;

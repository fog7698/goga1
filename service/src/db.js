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

module.exports = db;

// "Media referrals" - creators submit their social accounts, promote the VPN in real videos,
// and get paid weekly per view once approved.
//
// Deliberately NOT auto-scraped: Instagram and TikTok expose no legitimate public API for view
// counts (scraping them breaks their ToS and gets accounts/IPs banned), and there's no
// YOUTUBE_API_KEY configured for YouTube's official Data API either. So this is submission +
// admin moderation - exactly the manual review the program already requires anyway (checking the
// ad is real, not incentivized/botted, channel is VPN-only, etc. is a judgment call no scraper
// can make). An admin enters/updates each approved account's view count, typically weekly.

const db = require('./db');

const PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const MAX_ACCOUNTS_PER_PLATFORM = 10;
const PAYOUT_USD_PER_100K_VIEWS = 50;

// One-time total-views prize tiers. Update this list monthly as prizes rotate - there is no
// separate "prize catalog" storage, this constant IS the catalog.
const MEDIA_MILESTONES = [
  { views: 5000, prize: '+365 дней подписки (1 год VPN)', icon: 'shieldCheck' },
  { views: 50000, prize: '★ Тычковые ножи | Чистая вода (После полевых испытаний)', image: '/prizes/knife-bright-water.png' },
  { views: 100000, prize: '★ Нож с лезвием-крюком | Зуб тигра (Прямо с завода)', image: '/prizes/knife-tiger-tooth.png' },
  { views: 500000, prize: 'AirPods Pro (новейшие)', image: '/prizes/airpods-pro.jpg' },
  { views: 1000000, prize: '★ Нож выживания | Волны (Прямо с завода)', image: '/prizes/knife-waves.png' },
  { views: 5000000, prize: 'Apple Watch', image: '/prizes/apple-watch.jpg' },
];

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Add a submission for moderation; enforces the 10-per-platform cap. */
function addAccount(userId, platform, url) {
  if (!PLATFORMS.includes(platform)) return { error: 'bad_platform' };
  if (!isValidUrl(url)) return { error: 'bad_url' };
  const count = db
    .prepare('SELECT COUNT(*) c FROM media_accounts WHERE user_id = ? AND platform = ? AND status != ?')
    .get(userId, platform, 'rejected').c;
  if (count >= MAX_ACCOUNTS_PER_PLATFORM) return { error: 'limit_reached' };
  const info = db
    .prepare('INSERT INTO media_accounts (user_id, platform, url) VALUES (?,?,?)')
    .run(userId, platform, url);
  return { account: db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(info.lastInsertRowid) };
}

function listUserAccounts(userId) {
  return db.prepare('SELECT * FROM media_accounts WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function totalApprovedViews(userId) {
  return db
    .prepare("SELECT COALESCE(SUM(views),0) v FROM media_accounts WHERE user_id = ? AND status = 'approved'")
    .get(userId).v;
}

function mediaStats(userId) {
  const totalViews = totalApprovedViews(userId);
  const user = db.prepare('SELECT media_views_paid_baseline FROM users WHERE id = ?').get(userId);
  const unpaidViews = Math.max(0, totalViews - (user?.media_views_paid_baseline || 0));
  const pendingPayoutUsd = Math.floor(unpaidViews / 100000) * PAYOUT_USD_PER_100K_VIEWS;
  const nextMilestone = MEDIA_MILESTONES.find((m) => m.views > totalViews) || null;
  const prevThreshold = MEDIA_MILESTONES.filter((m) => m.views <= totalViews).pop();
  return {
    totalViews,
    pendingPayoutUsd,
    nextMilestone,
    milestonesReached: MEDIA_MILESTONES.filter((m) => m.views <= totalViews),
    progressBase: prevThreshold ? prevThreshold.views : 0,
    accounts: listUserAccounts(userId),
  };
}

/** Admin: everything awaiting review, or everything for a given status. */
function listAllAccounts(status) {
  const rows = status
    ? db
        .prepare(
          `SELECT ma.*, u.username FROM media_accounts ma JOIN users u ON u.id = ma.user_id
           WHERE ma.status = ? ORDER BY ma.created_at ASC`
        )
        .all(status)
    : db
        .prepare(
          `SELECT ma.*, u.username FROM media_accounts ma JOIN users u ON u.id = ma.user_id
           ORDER BY (ma.status = 'pending') DESC, ma.created_at DESC LIMIT 200`
        )
        .all();
  return rows;
}

function setStatus(id, status, note) {
  if (!['pending', 'approved', 'rejected'].includes(status)) return { error: 'bad_status' };
  db.prepare("UPDATE media_accounts SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    note ?? null,
    id
  );
  return { account: db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id) };
}

function setViews(id, views) {
  db.prepare("UPDATE media_accounts SET views = ?, updated_at = datetime('now') WHERE id = ?").run(views, id);
  return db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id);
}

/** Admin: record that `views` worth of the weekly payout has been paid via support. */
function recordMediaPayout(userId, views) {
  db.prepare('UPDATE users SET media_views_paid_baseline = media_views_paid_baseline + ? WHERE id = ?').run(
    views,
    userId
  );
}

module.exports = {
  PLATFORMS,
  MAX_ACCOUNTS_PER_PLATFORM,
  PAYOUT_USD_PER_100K_VIEWS,
  MEDIA_MILESTONES,
  addAccount,
  listUserAccounts,
  totalApprovedViews,
  mediaStats,
  listAllAccounts,
  setStatus,
  setViews,
  recordMediaPayout,
};

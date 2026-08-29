const db = require('./db');
const subs = require('./subscriptions');
const economy = require('./economy');

function listInventory(userId) {
  return db
    .prepare(
      `SELECT i.*, s.market_hash_name, s.display_name, s.image_url, s.price_rub AS current_price_rub
       FROM user_inventory i JOIN skins s ON s.id = i.skin_id
       WHERE i.user_id = ? ORDER BY i.created_at DESC`
    )
    .all(userId);
}

/** Record a skin win (case or upgrade) in the winner's inventory. */
function addToInventory(userId, skinId, priceRubAtWin, source) {
  const info = db
    .prepare('INSERT INTO user_inventory (user_id, skin_id, source, price_rub_at_win) VALUES (?,?,?,?)')
    .run(userId, skinId, source, priceRubAtWin);
  return info.lastInsertRowid;
}

function ownedItem(userId, inventoryId) {
  return db.prepare("SELECT * FROM user_inventory WHERE id = ? AND user_id = ? AND status = 'owned'").get(inventoryId, userId);
}

/** Convert a won skin back into subscription days at the same rate days are sold for
 * (economy.getConfig().dayPriceRub). This is a barter with the player, not a cash sale, so it
 * doesn't touch the site's skin prize balance - only real-money purchases and skin payouts do. */
function sellForDays(userId, inventoryId) {
  const item = ownedItem(userId, inventoryId);
  if (!item) return { error: 'not_found' };
  const dayPriceRub = economy.getConfig().dayPriceRub;
  const days = Math.max(1, Math.round(item.price_rub_at_win / dayPriceRub));
  const sub = subs.grantDays(userId, days, 'inventory-sale');
  db.prepare("UPDATE user_inventory SET status = 'sold', updated_at = datetime('now') WHERE id = ?").run(inventoryId);
  return { days, sub };
}

/** Queue a manual Steam trade - there's no Steam bot wired up, so an admin sends the trade by
 * hand from the "Заявки на вывод" panel and marks it sent/rejected. */
function requestWithdrawal(userId, inventoryId) {
  const item = ownedItem(userId, inventoryId);
  if (!item) return { error: 'not_found' };
  const user = db.prepare('SELECT steam_trade_url FROM users WHERE id = ?').get(userId);
  if (!user?.steam_trade_url) return { error: 'no_trade_url' };
  db.prepare('INSERT INTO withdrawal_requests (user_id, inventory_id, steam_trade_url) VALUES (?,?,?)').run(
    userId,
    inventoryId,
    user.steam_trade_url
  );
  db.prepare("UPDATE user_inventory SET status = 'withdraw_pending', updated_at = datetime('now') WHERE id = ?").run(inventoryId);
  return { ok: true };
}

// --- Admin side ---

function listWithdrawals(status) {
  const base = `SELECT w.*, u.username, s.display_name, s.image_url, i.price_rub_at_win
                FROM withdrawal_requests w
                JOIN users u ON u.id = w.user_id
                JOIN user_inventory i ON i.id = w.inventory_id
                JOIN skins s ON s.id = i.skin_id`;
  return status
    ? db.prepare(`${base} WHERE w.status = ? ORDER BY w.created_at DESC`).all(status)
    : db.prepare(`${base} ORDER BY w.created_at DESC`).all();
}

function completeWithdrawal(id, adminNote) {
  const req = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(id);
  if (!req) return { error: 'not_found' };
  db.prepare(
    "UPDATE withdrawal_requests SET status = 'sent', admin_note = COALESCE(?, admin_note), updated_at = datetime('now') WHERE id = ?"
  ).run(adminNote ?? null, id);
  db.prepare("UPDATE user_inventory SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?").run(req.inventory_id);
  return { ok: true };
}

/** Reject a withdrawal request - returns the skin to the player's inventory as owned. */
function rejectWithdrawal(id, adminNote) {
  const req = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(id);
  if (!req) return { error: 'not_found' };
  db.prepare(
    "UPDATE withdrawal_requests SET status = 'rejected', admin_note = COALESCE(?, admin_note), updated_at = datetime('now') WHERE id = ?"
  ).run(adminNote ?? null, id);
  db.prepare("UPDATE user_inventory SET status = 'owned', updated_at = datetime('now') WHERE id = ?").run(req.inventory_id);
  return { ok: true };
}

module.exports = {
  listInventory,
  addToInventory,
  sellForDays,
  requestWithdrawal,
  listWithdrawals,
  completeWithdrawal,
  rejectWithdrawal,
};

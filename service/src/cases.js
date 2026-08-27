const db = require('./db');
const subs = require('./subscriptions');
const { onSubscriptionsChanged } = require('./sync');

function getCaseTypes({ includeInactiveItems = false } = {}) {
  const types = db.prepare('SELECT * FROM case_types ORDER BY sort_order ASC, id ASC').all();
  const itemStmt = includeInactiveItems
    ? db.prepare('SELECT * FROM case_items WHERE case_type_id = ? ORDER BY id ASC')
    : db.prepare('SELECT * FROM case_items WHERE case_type_id = ? AND active = 1 ORDER BY id ASC');
  return types.map((t) => ({ ...t, items: itemStmt.all(t.id) }));
}

function pickWeighted(items) {
  const totalWeight = items.reduce((sum, it) => sum + Math.max(0, it.weight), 0);
  if (totalWeight <= 0) return null;
  let roll = Math.random() * totalWeight;
  for (const item of items) {
    roll -= Math.max(0, item.weight);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/** Spend coins to open a case; applies the won item's reward and returns { item, sub? }. */
function openCase(userId, caseKey) {
  const caseType = db.prepare('SELECT * FROM case_types WHERE key = ? AND active = 1').get(caseKey);
  if (!caseType) return { error: 'not_found' };
  const items = db.prepare('SELECT * FROM case_items WHERE case_type_id = ? AND active = 1').all(caseType.id);
  if (!items.length) return { error: 'empty' };
  if (!subs.spendCoins(userId, caseType.cost_coins)) return { error: 'not_enough_coins' };

  const item = pickWeighted(items);
  db.prepare('INSERT INTO case_openings (user_id, case_type_id, item_id) VALUES (?,?,?)').run(userId, caseType.id, item.id);

  let sub = null;
  if (item.kind === 'days') {
    sub = subs.grantDays(userId, item.value, subs.activeSubscription(userId)?.plan || 'case-reward');
    onSubscriptionsChanged();
  } else if (item.kind === 'coins') {
    subs.addCoins(userId, item.value);
  } else if (item.kind === 'percent') {
    db.prepare('UPDATE users SET promo_pending_percent = ? WHERE id = ?').run(item.value, userId);
  }

  return { item, sub, caseType };
}

module.exports = { getCaseTypes, openCase };

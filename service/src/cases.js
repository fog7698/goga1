const db = require('./db');
const subs = require('./subscriptions');
const economy = require('./economy');
const inventory = require('./inventory');
const { onSubscriptionsChanged } = require('./sync');

function getCaseTypes({ includeInactiveItems = false } = {}) {
  const types = db.prepare('SELECT * FROM case_types ORDER BY sort_order ASC, id ASC').all();
  const itemStmt = includeInactiveItems
    ? db.prepare(
        `SELECT ci.*, s.market_hash_name, s.display_name AS skin_display_name, s.image_url, s.price_rub AS skin_price_rub
         FROM case_items ci LEFT JOIN skins s ON s.id = ci.skin_id
         WHERE ci.case_type_id = ? ORDER BY ci.id ASC`
      )
    : db.prepare(
        `SELECT ci.*, s.market_hash_name, s.display_name AS skin_display_name, s.image_url, s.price_rub AS skin_price_rub
         FROM case_items ci LEFT JOIN skins s ON s.id = ci.skin_id
         WHERE ci.case_type_id = ? AND ci.active = 1 AND (ci.quantity IS NULL OR ci.quantity > 0)
         ORDER BY ci.id ASC`
      );
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

function openCase(userId, caseKey) {
  const caseType = db.prepare('SELECT * FROM case_types WHERE key = ? AND active = 1').get(caseKey);
  if (!caseType) return { error: 'not_found' };
  return caseType.currency === 'days' ? openDayCase(userId, caseType) : openCoinCase(userId, caseType);
}

/** Spend coins to open a case; applies the won item's reward and returns { item, sub? }. */
function openCoinCase(userId, caseType) {
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

/** Spend subscription days to open a CS2-skin-only case. The winning item is drawn only from the
 * subset the site can currently afford to lose money on (economy.getMaxPositivePayoutRub) - when
 * the prize balance can't cover any net-positive payout, only items priced at or below the
 * case's own cost are ever eligible, so the site can never be pushed into the red by this. */
function openDayCase(userId, caseType) {
  const dayPriceRub = economy.getConfig().dayPriceRub;
  const costRub = caseType.cost_days * dayPriceRub;
  const items = db
    .prepare(
      `SELECT ci.*, s.price_rub AS skin_price_rub, s.display_name AS skin_display_name, s.image_url, s.market_hash_name
       FROM case_items ci JOIN skins s ON s.id = ci.skin_id
       WHERE ci.case_type_id = ? AND ci.active = 1 AND (ci.quantity IS NULL OR ci.quantity > 0)`
    )
    .all(caseType.id);
  if (!items.length) return { error: 'empty' };

  const cap = economy.getMaxPositivePayoutRub();
  const eligible = items.filter((it) => it.skin_price_rub - costRub <= cap);
  if (!eligible.length) return { error: 'empty' }; // misconfigured case: nothing priced at/below cost

  if (!subs.spendDays(userId, caseType.cost_days)) return { error: 'not_enough_days' };
  onSubscriptionsChanged();

  const item = pickWeighted(eligible);
  db.prepare(
    'INSERT INTO case_openings (user_id, case_type_id, item_id, cost_rub, payout_rub) VALUES (?,?,?,?,?)'
  ).run(userId, caseType.id, item.id, costRub, item.skin_price_rub);
  if (item.quantity != null) {
    db.prepare('UPDATE case_items SET quantity = quantity - 1 WHERE id = ?').run(item.id);
  }
  const inventoryId = inventory.addToInventory(userId, item.skin_id, item.skin_price_rub, 'case');
  economy.applySpinResult(costRub, item.skin_price_rub);

  return {
    item: {
      title: item.skin_display_name || item.title,
      kind: 'skin',
      value: item.skin_price_rub,
      imageUrl: item.image_url,
    },
    caseType,
    inventoryId,
  };
}

module.exports = { getCaseTypes, openCase };

const db = require('./db');

/** Steam Community Market's public price-overview endpoint - no API key, but aggressively rate
 * limited, so this is only ever called from an explicit admin "Обновить цену" action, never on a
 * schedule or on page load. currency=5 is RUB. Returns null on any failure (network, rate limit,
 * unknown item) so the caller can fall back to the admin's manually-entered price. */
async function fetchSteamPrice(marketHashName) {
  const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(marketHashName)}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.success) return null;
  const raw = data.lowest_price || data.median_price;
  if (!raw) return null;
  // "15,50 pуб." / "1 234,50 руб." -> 1234.50
  const cleaned = String(raw)
    .replace(/[^\d.,]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const price = Number(cleaned);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function listSkins() {
  return db.prepare('SELECT * FROM skins ORDER BY price_rub DESC').all();
}

function getSkin(id) {
  return db.prepare('SELECT * FROM skins WHERE id = ?').get(id);
}

function createSkin({ marketHashName, displayName, imageUrl, priceRub }) {
  const info = db
    .prepare(
      "INSERT INTO skins (market_hash_name, display_name, image_url, price_rub, price_updated_at) VALUES (?,?,?,?,datetime('now'))"
    )
    .run(marketHashName, displayName || marketHashName, imageUrl || null, Number(priceRub) || 0);
  return getSkin(info.lastInsertRowid);
}

function updateSkin(id, { displayName, imageUrl, priceRub, availableForUpgrade }) {
  db.prepare(
    `UPDATE skins SET
       display_name = COALESCE(?, display_name),
       image_url = COALESCE(?, image_url),
       price_rub = COALESCE(?, price_rub),
       price_updated_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE price_updated_at END,
       available_for_upgrade = COALESCE(?, available_for_upgrade)
     WHERE id = ?`
  ).run(
    displayName ?? null,
    imageUrl ?? null,
    Number.isFinite(priceRub) ? priceRub : null,
    Number.isFinite(priceRub) ? 1 : null,
    typeof availableForUpgrade === 'boolean' ? (availableForUpgrade ? 1 : 0) : null,
    id
  );
  return getSkin(id);
}

function deleteSkin(id) {
  db.prepare('DELETE FROM skins WHERE id = ?').run(id);
}

/** Refresh one skin's price from Steam Market; leaves the stored price untouched if Steam
 * doesn't answer (rate limit, unknown name) rather than zeroing it out. */
async function refreshSkinPrice(id) {
  const skin = getSkin(id);
  if (!skin) return { error: 'not_found' };
  const price = await fetchSteamPrice(skin.market_hash_name);
  if (price == null) return { error: 'steam_unavailable', skin };
  return { skin: updateSkin(id, { priceRub: price }) };
}

module.exports = { fetchSteamPrice, listSkins, getSkin, createSkin, updateSkin, deleteSkin, refreshSkinPrice };

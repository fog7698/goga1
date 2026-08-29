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
  // "15,50 pуб." / "1 234,50 руб." -> 1234.50. Match only the leading numeric run (digits, the
  // thousands-separator spaces, one decimal separator) so the currency suffix - including its
  // own trailing "." in "руб." - never leaks into the parsed number.
  const numeric = String(raw).match(/^[\d\s.,]+/);
  if (!numeric) return null;
  const cleaned = numeric[0].trim().replace(/\s+/g, '').replace(',', '.');
  const price = Number(cleaned);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** The item's real photo, scraped off its public Steam Market listing page's `og:image` meta tag
 * - same no-key/rate-limited caveat as fetchSteamPrice. Simpler and more reliable than Steam's
 * old /render?format=json asset payload, which their current market UI no longer serves (it
 * answers with the page's HTML shell even when format=json is requested). Returns null on any
 * failure (network, rate limit, unknown item, no og:image found). */
async function fetchSteamIcon(marketHashName) {
  const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await res.text().catch(() => '');
  const match = html.match(/<meta property="og:image" content="([^"]+)"/);
  return match ? match[1] : null;
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

/** Refresh one skin's price AND real photo from Steam Market in one admin-triggered action;
 * leaves whichever field Steam didn't answer for (rate limit, unknown name) untouched rather
 * than zeroing it out. */
async function refreshSkinPrice(id) {
  const skin = getSkin(id);
  if (!skin) return { error: 'not_found' };
  const [price, iconUrl] = await Promise.all([
    fetchSteamPrice(skin.market_hash_name),
    fetchSteamIcon(skin.market_hash_name),
  ]);
  if (price == null && iconUrl == null) return { error: 'steam_unavailable', skin };
  return { skin: updateSkin(id, { priceRub: price, imageUrl: iconUrl }) };
}

module.exports = {
  fetchSteamPrice,
  fetchSteamIcon,
  listSkins,
  getSkin,
  createSkin,
  updateSkin,
  deleteSkin,
  refreshSkinPrice,
};

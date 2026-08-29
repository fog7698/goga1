const db = require('./db');

// Steam's own market endpoints start silently failing (not a 429, just an empty/unsuccessful
// response) after roughly 15-20 requests in quick succession - verified by hand: a burst of ~2
// req/s got throttled after ~10s, and the very same "invalid" names succeeded again once spaced
// out. So every Steam request in this module, whichever function issues it, waits for a shared
// slot at least STEAM_MIN_INTERVAL_MS after the previous one - comfortably under that limit.
const STEAM_MIN_INTERVAL_MS = 3500;
let steamNextSlotAt = 0;
function steamThrottle() {
  const now = Date.now();
  const slot = Math.max(now, steamNextSlotAt);
  steamNextSlotAt = slot + STEAM_MIN_INTERVAL_MS;
  const wait = slot - now;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

/** Steam Community Market's public price-overview endpoint - no API key, but aggressively rate
 * limited, so this is only ever called from an explicit admin "Обновить цену"/"Обновить всё"
 * action, never on a schedule or on page load. currency=5 is RUB. Returns null on any failure
 * (network, rate limit, unknown item) so the caller can fall back to the admin's own price. */
async function fetchSteamPrice(marketHashName) {
  await steamThrottle();
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
  await steamThrottle();
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

function updateSkin(id, { displayName, imageUrl, priceRub, availableForUpgrade, marketHashName }) {
  db.prepare(
    `UPDATE skins SET
       market_hash_name = COALESCE(?, market_hash_name),
       display_name = COALESCE(?, display_name),
       image_url = COALESCE(?, image_url),
       price_rub = COALESCE(?, price_rub),
       price_updated_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE price_updated_at END,
       available_for_upgrade = COALESCE(?, available_for_upgrade)
     WHERE id = ?`
  ).run(
    marketHashName ?? null,
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

function marketHashNameTaken(name, excludeId) {
  return !!db.prepare('SELECT id FROM skins WHERE market_hash_name = ? AND id != ?').get(name, excludeId);
}

// Some of the catalog's auto-generated (skin, wear) pairings don't actually exist on Steam - not
// every skin ships in all 5 wears (e.g. AK-47 | Redline has no Factory New; Doppler knives are
// FN/MW only). These are the wears actually worth trying, in the order most CS2 skins support.
const FALLBACK_WEARS = ['Field-Tested', 'Minimal Wear', 'Factory New', 'Well-Worn', 'Battle-Scarred'];

/** Refresh one skin's price AND real photo from Steam Market in one admin-triggered action. If
 * the stored name doesn't resolve at all, tries the other 4 wear conditions on the same base
 * skin before giving up, and adopts whichever one actually exists on Steam (skipping any that
 * would collide with a different skin already in the catalog). Leaves whichever field Steam
 * didn't answer for (rate limit, no such listing) untouched rather than zeroing it out. */
async function refreshSkinPrice(id) {
  const skin = getSkin(id);
  if (!skin) return { error: 'not_found' };

  let name = skin.market_hash_name;
  let [price, iconUrl] = await Promise.all([fetchSteamPrice(name), fetchSteamIcon(name)]);

  if (price == null && iconUrl == null) {
    const baseName = name.replace(/\s*\([^)]*\)\s*$/, '');
    for (const wear of FALLBACK_WEARS) {
      const candidate = `${baseName} (${wear})`;
      if (candidate === name || marketHashNameTaken(candidate, id)) continue;
      // eslint-disable-next-line no-await-in-loop
      const [p, ic] = await Promise.all([fetchSteamPrice(candidate), fetchSteamIcon(candidate)]);
      if (p != null || ic != null) {
        name = candidate;
        price = p;
        iconUrl = ic;
        break;
      }
    }
  }

  if (price == null && iconUrl == null) return { error: 'steam_unavailable', skin };
  return {
    skin: updateSkin(id, {
      priceRub: price,
      imageUrl: iconUrl,
      marketHashName: name !== skin.market_hash_name ? name : undefined,
    }),
  };
}

let bulkState = { running: false, done: 0, total: 0, fixedNames: 0, startedAt: null, finishedAt: null };

function getBulkRefreshState() {
  return { ...bulkState };
}

/** Walk the whole catalog refreshing price+photo one skin at a time - every actual Steam request
 * anywhere in this module already goes through the shared steamThrottle, so this just needs to
 * issue them; no extra per-item delay needed. Runs in the background, poll getBulkRefreshState()
 * for progress. Refuses to start a second run concurrently. */
function refreshAllSkins() {
  if (bulkState.running) return { error: 'already_running' };
  const all = listSkins();
  bulkState = { running: true, done: 0, total: all.length, fixedNames: 0, startedAt: new Date().toISOString(), finishedAt: null };

  (async () => {
    for (const s of all) {
      try {
        const result = await refreshSkinPrice(s.id);
        if (result.skin && result.skin.market_hash_name !== s.market_hash_name) bulkState.fixedNames++;
      } catch {
        // keep going - one bad skin shouldn't stop the rest of the catalog
      }
      bulkState.done++;
    }
    bulkState.running = false;
    bulkState.finishedAt = new Date().toISOString();
  })();

  return { ok: true, total: all.length };
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
  refreshAllSkins,
  getBulkRefreshState,
};

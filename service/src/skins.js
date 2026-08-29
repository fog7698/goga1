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

/** Partial update - only touches the columns the caller actually passed. Unlike the previous
 * COALESCE-everything version, this can tell "field omitted, leave it alone" (pass `undefined` or
 * just don't include the key) apart from "field explicitly cleared" (pass `null`) - needed so a
 * rename that finds no fresh photo can blank out the OLD item's now-irrelevant photo instead of
 * silently leaving it displayed under the new name (see refreshSkinPrice). */
function updateSkin(id, opts = {}) {
  const sets = [];
  const params = [];
  if (opts.marketHashName !== undefined) {
    sets.push('market_hash_name = ?');
    params.push(opts.marketHashName);
  }
  if (opts.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(opts.displayName);
  }
  if (opts.imageUrl !== undefined) {
    sets.push('image_url = ?');
    params.push(opts.imageUrl);
  }
  if (opts.priceRub !== undefined && Number.isFinite(opts.priceRub)) {
    sets.push('price_rub = ?', "price_updated_at = datetime('now')");
    params.push(opts.priceRub);
  }
  if (opts.availableForUpgrade !== undefined) {
    sets.push('available_for_upgrade = ?');
    params.push(opts.availableForUpgrade ? 1 : 0);
  }
  if (sets.length) {
    db.prepare(`UPDATE skins SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
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

/** Refresh one skin's price AND real photo from Steam Market in one admin-triggered action. A
 * real PRICE is the thing that actually matters (it's what the whole economy - drop odds, payout
 * caps - runs on), so success is defined by finding one, not just an image: some item pages exist
 * and have a real og:image (so an earlier version of this function accepted them) but currently
 * have zero active market listings to price from - M4A4 | Howl and most StatTrak variants of the
 * older Arms Deal skins (Fire Serpent, Vulcan, ...) are like this. Treating that as "done" left
 * whatever stale price the row had before the call (often a leftover from a previous rename)
 * silently displayed as if it were current. Now: if the stored name has no price, the other 4
 * wear conditions on the same base skin are tried (skipping any that would collide with a
 * different skin already in the catalog) until one actually has a price; only then is the row
 * updated. No price found anywhere -> error, row left untouched (never a stale guess). */
async function refreshSkinPrice(id) {
  const skin = getSkin(id);
  if (!skin) return { error: 'not_found' };

  let name = skin.market_hash_name;
  let price = await fetchSteamPrice(name);
  let iconUrl = await fetchSteamIcon(name);

  if (price == null) {
    const baseName = name.replace(/\s*\([^)]*\)\s*$/, '');
    for (const wear of FALLBACK_WEARS) {
      const candidate = `${baseName} (${wear})`;
      if (candidate === name || marketHashNameTaken(candidate, id)) continue;
      // eslint-disable-next-line no-await-in-loop
      const p = await fetchSteamPrice(candidate);
      if (p != null) {
        // eslint-disable-next-line no-await-in-loop
        const ic = await fetchSteamIcon(candidate);
        name = candidate;
        price = p;
        iconUrl = ic;
        break;
      }
    }
  }

  if (price == null) return { error: 'steam_unavailable', skin };
  const renamed = name !== skin.market_hash_name;
  return {
    skin: updateSkin(id, {
      priceRub: price,
      // A fresh photo always wins. No fresh photo but the name changed -> the OLD photo belongs
      // to a different item now, so clear it (null) rather than leave it displayed as if it were
      // this one's. No fresh photo and the name is unchanged -> leave whatever photo it already
      // had alone (undefined) - it's still valid, this was probably just a transient miss.
      imageUrl: iconUrl !== null ? iconUrl : (renamed ? null : undefined),
      marketHashName: renamed ? name : undefined,
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

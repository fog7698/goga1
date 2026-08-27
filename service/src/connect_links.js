// Builds one-tap "connect" links for VPN client apps.
//
// Happ: uses Happ's own official encryption endpoint (https://crypto.happ.su/, documented at
// happ.su/main/dev-docs/crypto-link) to turn our https subscription URL into a happ://crypt5/...
// deep link that opens straight into the app with the subscription pre-added.
//
// INCY: intentionally NOT using any third-party "deep link encoder" library/service - a search
// for INCY's link format turned up only an unofficial GitHub package claiming to embed a shared
// AES key "shipped in every client", which is a textbook supply-chain red flag and was not
// integrated. Instead we fall back to a bare vless:// URI, which INCY's own docs confirm it
// recognizes directly (same mechanism Happ itself uses for single-server import via clipboard).

const happCache = new Map(); // subscriptionUrl -> happ://crypt5/... link

async function happConnectLink(subscriptionUrl) {
  if (happCache.has(subscriptionUrl)) return happCache.get(subscriptionUrl);
  try {
    const res = await fetch('https://crypto.happ.su/api-v2.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: subscriptionUrl }),
    });
    const text = await res.text();
    const match = text.match(/happ:\/\/crypt\d+\/\S+/);
    const link = match ? match[0].replace(/["'\\,}\s]+$/, '') : subscriptionUrl;
    happCache.set(subscriptionUrl, link);
    return link;
  } catch {
    return subscriptionUrl; // graceful fallback: plain subscription URL still works via manual add
  }
}

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';

/** Telegram inline-keyboard buttons and Mini App `tg.openLink` both silently reject/drop
 * anything that isn't http(s) - a happ:// or vless:// button either fails to send (Telegram
 * API error) or fails to open (Mini App WebView). Point buttons at our own https redirect
 * instead; the 302 hands off to the real deep link only once it reaches a real browser/OS,
 * which both Telegram and Mini App WebViews are happy to follow. */
function redirectLinks(uuid) {
  if (!PUBLIC_URL || !uuid) return null;
  return {
    happ: `${PUBLIC_URL}/connect/${uuid}/happ`,
    incy: `${PUBLIC_URL}/connect/${uuid}/incy`,
  };
}

module.exports = { happConnectLink, redirectLinks };

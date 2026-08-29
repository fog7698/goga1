const OWNER_UUID = process.env.VPN_UUID;

// The VPN tunnel itself (xray) no longer runs inside this Railway container - it runs standalone
// on a dedicated VPS, which pulls its client list on its own via the /internal/vpn-clients
// endpoint in web.js. This file only builds the vless:// connect links pointing at that VPS.
//
// Direct VLESS+REALITY straight to the VPS's IP (still running, see VPN_HOST/VPN_PORT below)
// turned out to complete its handshake fine but have its actual data flow stalled in real RU
// testing - true for REALITY (two different dest domains, with and without Vision flow) AND for
// Hysteria2/QUIC, while plain HTTPS to the same IP worked fine and a VPN on a different provider
// worked immediately. That points at this VPS's specific IP/network being throttled for
// tunnel-shaped traffic specifically, not a protocol fingerprint. Fronting the same VLESS server
// through a Cloudflare tunnel (real TLS terminated by Cloudflare, indistinguishable from any
// other Cloudflare-hosted site) tested working end-to-end in real conditions, so that's the
// link every subscriber actually gets now. The direct VPN_HOST address is kept below only as a
// fallback path, not used by vlessLink.
const CF_HOST = process.env.CF_HOST || '';
const CF_WS_PATH = process.env.CF_WS_PATH || '/xr-8f3a2b1c';
const VPN_HOST = process.env.VPN_HOST || '';
const VPN_PORT = process.env.VPN_PORT || '443';
const REALITY_PUBLIC_KEY = process.env.VPN_REALITY_PUBLIC_KEY || '';
const REALITY_SHORT_ID = process.env.VPN_REALITY_SHORT_ID || '';
const REALITY_SNI = process.env.VPN_REALITY_SNI || 'www.python.org';

function vlessLink(uuid, remark) {
  const r = encodeURIComponent(remark);
  if (CF_HOST) {
    const params = new URLSearchParams({
      security: 'tls',
      encryption: 'none',
      type: 'ws',
      path: CF_WS_PATH,
      host: CF_HOST,
      sni: CF_HOST,
    });
    return `vless://${uuid}@${CF_HOST}:443?${params.toString()}#${r}`;
  }
  const params = new URLSearchParams({
    security: 'reality',
    encryption: 'none',
    pbk: REALITY_PUBLIC_KEY,
    fp: 'chrome',
    sni: REALITY_SNI,
    sid: REALITY_SHORT_ID,
    type: 'tcp',
    flow: 'xtls-rprx-vision',
  });
  return `vless://${uuid}@${VPN_HOST}:${VPN_PORT}?${params.toString()}#${r}`;
}

const LOCATIONS = [
  '\u{1F1EE}\u{1F1F3} India', '\u{1F1EE}\u{1F1E9} Indonesia', '\u{1F1F8}\u{1F1EC} Singapore',
  '\u{1F1F9}\u{1F1ED} Thailand', '\u{1F1F0}\u{1F1ED} Cambodia', '\u{1F1ED}\u{1F1F0} Hong Kong',
  '\u{1F1F9}\u{1F1FC} Taiwan', '\u{1F1F9}\u{1F1F7} Turkey', '\u{1F1E8}\u{1F1FE} Cyprus',
  '\u{1F1FA}\u{1F1F8} US #1', '\u{1F1FA}\u{1F1F8} US #2 Dallas', '\u{1F1EF}\u{1F1F5} Japan',
  '\u{1F1E8}\u{1F1E6} Canada', '\u{1F1E6}\u{1F1FA} Australia', '\u{1F1F2}\u{1F1FE} Malaysia',
  '\u{1F1F3}\u{1F1F1} Netherlands #1', '\u{1F1F8}\u{1F1EA} Sweden', '\u{1F1E6}\u{1F1F1} Albania',
  '\u{1F1F3}\u{1F1F4} Norway', '\u{1F1EA}\u{1F1F8} Spain', '\u{1F1F1}\u{1F1FB} Latvia',
  '\u{1F1EB}\u{1F1EE} Finland #2', '\u{1F1E8}\u{1F1FF} Czech',
];
const LTE_BYPASS = Array.from({ length: 8 }, (_, i) => `LTE • Обход Б/С #${i + 1} - Все Операторы`);
const WHITELIST = Array.from({ length: 3 }, (_, i) => `Белый список • Обход блокировок #${i + 1}`);

function formatExpiry(expiresAt) {
  if (!expiresAt) return null;
  const d = new Date(expiresAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** `expiresAt` (SQLite `datetime('now')` string, UTC) is embedded as a read-only info entry
 * at the top of the location list so it shows inside Happ/INCY's own server picker. */
function subscriptionBase64(uuid, expiresAt) {
  const names = [...LOCATIONS, ...LTE_BYPASS, ...WHITELIST];
  const expiryLabel = formatExpiry(expiresAt);
  if (expiryLabel) names.unshift(`⏳ Подписка активна до ${expiryLabel}`);
  const body = names.map((n) => vlessLink(uuid, n)).join('\n');
  return Buffer.from(body, 'utf8').toString('base64');
}

const COUNTRY_COUNT = new Set(
  LOCATIONS.map((l) => l.replace(/#\d+/, '').replace(/\s+(Dallas)?$/, '').trim())
).size;

module.exports = {
  vlessLink,
  subscriptionBase64,
  formatExpiry,
  OWNER_UUID,
  COUNTRY_COUNT,
};

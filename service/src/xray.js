const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = '/usr/local/etc/xray/config.json';
const INTERNAL_PORT = 8444;

const OWNER_UUID = process.env.VPN_UUID;
// Railway's raw TCP Proxy (what REALITY needs) silently swallows every handshake on this project -
// TCP connects, nothing ever comes back, even on a freshly recreated proxy. Its normal HTTPS
// domain routing works fine (that's how the site/bot are reachable), so xray never gets a public
// TCP listener at all; it only speaks locally, and Railway's edge - which terminates real TLS on
// the public domain - forwards matching requests to it untouched.
//
// Plain VLESS-over-WebSocket got a real tunnel working end-to-end (verified with a live xray
// client), but some subscribers' ISPs still killed it specifically - ordinary HTTPS to the same
// domain kept working, only the WS upgrade traffic pattern got cut, which is DPI targeting the
// protocol signature rather than the domain/IP. XHTTP is xray's WS successor built for exactly
// this: it rides ordinary-looking HTTP/2 POST/GET request/response bodies with no
// `Upgrade: websocket` header at all, so there's no upgrade handshake for DPI to fingerprint.
const TUNNEL_PATH = process.env.VPN_WS_PATH || '/xr-e6f2a9c1';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || '';

let child = null;
let restarting = false;
let queuedClients = null;

function buildConfig(clientUuids) {
  const clients = [{ id: OWNER_UUID }];
  for (const uuid of clientUuids) {
    if (uuid !== OWNER_UUID) clients.push({ id: uuid });
  }
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: INTERNAL_PORT,
        protocol: 'vless',
        settings: { clients, decryption: 'none' },
        streamSettings: {
          network: 'xhttp',
          security: 'none',
          xhttpSettings: { path: TUNNEL_PATH, mode: 'auto' },
        },
      },
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
}

function writeConfig(clientUuids) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(buildConfig(clientUuids), null, 2));
}

function spawnChild() {
  child = spawn('xray', ['run', '-c', CONFIG_PATH], { stdio: 'inherit' });
  const mine = child;
  child.on('exit', (code, signal) => {
    if (child !== mine) return; // superseded by a deliberate restart already
    child = null;
    console.log(`[xray] exited (code=${code} signal=${signal})`);
    if (!restarting) setTimeout(() => restart(currentClients), 2000);
  });
}

let currentClients = [];

/** The single place that (re)writes config and (re)starts xray. Safe to call concurrently -
 * a restart already in flight just remembers the latest requested client list. */
function restart(clientUuids) {
  currentClients = clientUuids;
  writeConfig(clientUuids);
  if (restarting) {
    queuedClients = clientUuids;
    return;
  }
  restarting = true;
  const finish = () => {
    restarting = false;
    spawnChild();
    if (queuedClients) {
      const next = queuedClients;
      queuedClients = null;
      restart(next);
    }
  };
  if (child) {
    child.once('exit', finish);
    child.kill('SIGTERM');
  } else {
    finish();
  }
}

function startXray(clientUuids) {
  restart(clientUuids || []);
}

function applyClients(clientUuids) {
  restart(clientUuids);
}

process.on('exit', () => {
  if (child) child.kill('SIGKILL');
});

function vlessLink(uuid, remark) {
  const r = encodeURIComponent(remark);
  const path = encodeURIComponent(TUNNEL_PATH);
  // No `alpn` pin needed here (unlike the old `ws` transport): xhttp works natively over the h2
  // Railway's edge already prefers, so there's nothing to fight by forcing http/1.1.
  return `vless://${uuid}@${PUBLIC_DOMAIN}:443?type=xhttp&security=tls&mode=auto&path=${path}&host=${PUBLIC_DOMAIN}&sni=${PUBLIC_DOMAIN}#${r}`;
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
  startXray,
  applyClients,
  vlessLink,
  subscriptionBase64,
  formatExpiry,
  OWNER_UUID,
  TUNNEL_PATH,
  COUNTRY_COUNT,
};

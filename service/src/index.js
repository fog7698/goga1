const xray = require('./xray');
const subs = require('./subscriptions');
const { createBot } = require('./bot');
const { createApp } = require('./web');

function printBootLinks() {
  const link = xray.vlessLink(xray.OWNER_UUID, 'TokyoVPN-Owner');
  console.log('==================================================================');
  console.log('[vpn] Owner link (unchanged, same key as before):');
  console.log('');
  console.log(link);
  console.log('');
  console.log('==================================================================');
}

async function main() {
  // 1. The VPN tunnel (xray) runs on its own VPS now, not here - see xray.js. It pulls its
  // client list from /internal/vpn-clients on its own schedule.
  printBootLinks();

  // 2. Telegram bot (no-ops if BOT_TOKEN is unset).
  const bot = createBot();

  // 3. Web (public site + admin + webhooks) — same port the old subscription server used.
  const app = createApp(bot ? bot.api : null);
  const PORT = process.env.WEB_PORT || process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`[web] listening on :${PORT}`));

  // 4. Expiry sweep every 5 minutes - the VPN VPS picks up the change on its next poll.
  setInterval(() => {
    subs.sweepExpired();
  }, 5 * 60 * 1000);

  if (bot) {
    bot.start().catch((e) => console.error('[bot] failed to start:', e));
    console.log('[bot] polling started');
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

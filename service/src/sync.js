// The VPN VPS pulls its own client list from /internal/vpn-clients on a timer (see xray.js and
// web.js) instead of being pushed to, so there's nothing left to do here on a DB change. Kept as
// a no-op so the many call sites across web.js/bot.js don't all need to change too.
function onSubscriptionsChanged() {}

module.exports = { onSubscriptionsChanged };

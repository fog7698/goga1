const subs = require('./subscriptions');
const xray = require('./xray');

/** Re-render xray's client list from the DB and restart it if anything changed. */
function onSubscriptionsChanged() {
  xray.applyClients(subs.activeClientUuids());
}

module.exports = { onSubscriptionsChanged };

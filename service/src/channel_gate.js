// Optional "must be subscribed to our channel" gate in front of the trial period.
// Disabled (no-op, everyone passes) until REQUIRED_CHANNEL is set - so this can ship before
// the channel itself is decided, and turned on later just by setting the Railway variable.
//
// REQUIRED_CHANNEL: the channel Telegram identifies it by for getChatMember - either its
//   @username or its numeric chat id (e.g. -1001234567890). The bot must be an admin of
//   that channel, or getChatMember will fail for every user.
// REQUIRED_CHANNEL_URL: the link shown to the user to go subscribe. Defaults to
//   https://t.me/<username> when REQUIRED_CHANNEL is an @username; set it explicitly if the
//   channel is private (invite link) or REQUIRED_CHANNEL is a numeric id.

const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || null;
const REQUIRED_CHANNEL_URL =
  process.env.REQUIRED_CHANNEL_URL ||
  (REQUIRED_CHANNEL && REQUIRED_CHANNEL.startsWith('@') ? `https://t.me/${REQUIRED_CHANNEL.slice(1)}` : null);

const MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);

function enabled() {
  return Boolean(REQUIRED_CHANNEL);
}

/** Fails closed: if REQUIRED_CHANNEL is set but we can't verify (bot not admin, bad id, API
 * hiccup), the trial stays blocked rather than silently letting everyone through. */
async function isSubscribed(botApi, userId) {
  if (!enabled()) return true;
  try {
    const member = await botApi.getChatMember(REQUIRED_CHANNEL, userId);
    return MEMBER_STATUSES.has(member.status);
  } catch (e) {
    console.error('[channel_gate] getChatMember failed - is the bot an admin of', REQUIRED_CHANNEL, '?', e.message);
    return false;
  }
}

module.exports = { enabled, isSubscribed, channelUrl: REQUIRED_CHANNEL_URL };

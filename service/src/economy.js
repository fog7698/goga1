const db = require('./db');

function getConfigNumber(key, fallback) {
  const row = db.prepare('SELECT value FROM site_config WHERE key = ?').get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function setConfigValue(key, value) {
  db.prepare(
    'INSERT INTO site_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function getSiteBalance() {
  return getConfigNumber('skin_prize_balance_rub', 0);
}

/** Admin-set prize-fund balance (RUB set aside to buy/pay out skins). Clamped at 0 - the fund
 * itself is never allowed to go negative. */
function setSiteBalance(value) {
  const n = Math.max(0, Number(value) || 0);
  setConfigValue('skin_prize_balance_rub', n);
  return n;
}

function getConfig() {
  return {
    marginTargetPercent: getConfigNumber('margin_target_percent', 20),
    payoutShareFactor: getConfigNumber('payout_share_factor', 0.8),
    activeWindowHours: getConfigNumber('active_window_hours', 24),
    dayPriceRub: getConfigNumber('day_price_rub', 2.5),
  };
}

function updateConfig(partial = {}) {
  if (Number.isFinite(Number(partial.marginTargetPercent))) setConfigValue('margin_target_percent', Number(partial.marginTargetPercent));
  if (Number.isFinite(Number(partial.payoutShareFactor))) setConfigValue('payout_share_factor', Number(partial.payoutShareFactor));
  if (Number.isFinite(Number(partial.activeWindowHours))) setConfigValue('active_window_hours', Number(partial.activeWindowHours));
  if (Number.isFinite(Number(partial.dayPriceRub))) setConfigValue('day_price_rub', Number(partial.dayPriceRub));
  return getConfig();
}

/** All-time real-money revenue - what the site actually collected, as opposed to the day-priced
 * cases/upgrader where users only ever stake subscription days or skins they already won. */
function getTotalDeposits() {
  return db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status = 'succeeded'").get().s;
}

/** Distinct users who've opened a day-priced case or run a skin-targeted upgrade in the last
 * `windowHours` - the "how many people might all cash out at once" estimate the payout cap is
 * divided across. Floored at 1 so a quiet site doesn't divide by zero. */
function getActiveSpinnerCount(windowHours) {
  const since = `-${windowHours} hours`;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) c FROM (
         SELECT user_id FROM case_openings WHERE cost_rub IS NOT NULL AND created_at >= datetime('now', ?)
         UNION
         SELECT user_id FROM upgrade_attempts WHERE (stake_skin_id IS NOT NULL OR target_skin_id IS NOT NULL) AND created_at >= datetime('now', ?)
       )`
    )
    .get(since, since);
  return Math.max(1, row.c);
}

/** Max RUB a single case spin / upgrade attempt is allowed to pay the user ABOVE their stake,
 * right now. This is the whole "site can never be forced into the red" guardrail:
 *  - 0 whenever the prize balance itself is 0 (or below the reserved margin) - callers must
 *    then only offer break-even-or-loss outcomes.
 *  - otherwise, the balance above the margin-target reserve is split across recently-active
 *    spinners and only a configurable share of each person's split is ever put at risk in one
 *    go, so one lucky spin can't drain the fund a dozen simultaneous players are drawing from.
 *  - never exceeds the balance itself, so applySpinResult can never push it negative. */
function getMaxPositivePayoutRub() {
  const balance = getSiteBalance();
  if (balance <= 0) return 0;
  const { marginTargetPercent, payoutShareFactor, activeWindowHours } = getConfig();
  const marginTarget = getTotalDeposits() * (marginTargetPercent / 100);
  const available = Math.max(0, balance - marginTarget);
  const spinners = getActiveSpinnerCount(activeWindowHours);
  const cap = (available * payoutShareFactor) / spinners;
  return Math.max(0, Math.min(cap, balance));
}

/** Settle one spin's effect on the prize balance: `costRub` is the RUB value of what the user
 * staked, `payoutRub` is the RUB value of what they received. A loss (payout < cost) grows the
 * balance; a net win shrinks it. Defensively clamped at 0 - callers are expected to have already
 * respected getMaxPositivePayoutRub, this is just a last-resort floor. */
function applySpinResult(costRub, payoutRub) {
  return setSiteBalance(getSiteBalance() + costRub - payoutRub);
}

module.exports = {
  getSiteBalance,
  setSiteBalance,
  getConfig,
  updateConfig,
  getTotalDeposits,
  getActiveSpinnerCount,
  getMaxPositivePayoutRub,
  applySpinResult,
};

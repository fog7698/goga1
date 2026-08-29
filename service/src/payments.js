const crypto = require('crypto');
const db = require('./db');
const { PLANS, priceForPlan } = require('./subscriptions');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

function configured() {
  return Boolean(SHOP_ID && SECRET_KEY);
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');
}

/** Create a YooKassa payment for a plan and return its confirmation redirect URL.
 * `extraMetadata` rides along on the payment (e.g. { gift: 'true' }) and comes back verbatim
 * on the webhook's fetched payment object - that's how the webhook tells a gift purchase apart
 * from a normal one without needing its own DB column. */
async function createPayment(userId, planKey, returnUrl, extraMetadata) {
  if (!configured()) return { error: 'not_configured' };
  const plan = PLANS[planKey];
  if (!plan) return { error: 'bad_plan' };
  const { amount } = priceForPlan(planKey, userId);

  const res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      'Idempotence-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: returnUrl },
      capture: true,
      description: extraMetadata?.gift === 'true' ? `TOKYO VPN — подарок: ${plan.label}` : `TOKYO VPN — ${plan.label}`,
      metadata: { user_id: String(userId), plan: planKey, ...extraMetadata },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: 'yookassa_error', detail: text };
  }
  const payment = await res.json();
  db.prepare(
    'INSERT INTO payments (user_id, plan, amount, yookassa_payment_id, status) VALUES (?,?,?,?,?)'
  ).run(userId, planKey, amount, payment.id, 'pending');
  return { url: payment.confirmation?.confirmation_url, paymentId: payment.id };
}

/** Same as createPayment but for an arbitrary day count at `amountRub` (subscriptions.priceForDays)
 * instead of a fixed PLANS tier. The `payments` row gets plan='custom_days' plus the day count in
 * its `days` column so the webhook knows how many days to grant without a metadata round-trip. */
async function createCustomPayment(userId, days, amountRub, returnUrl, extraMetadata) {
  if (!configured()) return { error: 'not_configured' };

  const res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      'Idempotence-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: { value: amountRub.toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: returnUrl },
      capture: true,
      description:
        extraMetadata?.gift === 'true' ? `TOKYO VPN — подарок: ${days} дн.` : `TOKYO VPN — ${days} дн.`,
      metadata: { user_id: String(userId), plan: 'custom_days', days: String(days), ...extraMetadata },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: 'yookassa_error', detail: text };
  }
  const payment = await res.json();
  db.prepare(
    'INSERT INTO payments (user_id, plan, amount, days, yookassa_payment_id, status) VALUES (?,?,?,?,?,?)'
  ).run(userId, 'custom_days', amountRub, days, payment.id, 'pending');
  return { url: payment.confirmation?.confirmation_url, paymentId: payment.id };
}

/** Re-check a payment's real status directly with YooKassa (never trust the webhook body alone). */
async function fetchPaymentStatus(paymentId) {
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = { configured, createPayment, createCustomPayment, fetchPaymentStatus };

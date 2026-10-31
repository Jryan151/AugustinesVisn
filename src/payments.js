'use strict';
/* =====================================================================
   payments.js — the deposit, through Stripe Checkout (Stripe's own hosted payment page).

   The card never touches this server, so there's no card form to secure here. Stripe's API is called directly with
   fetch (no library to install). Every call that creates something sends an Idempotency-Key, so a retried request
   can't make a second checkout.

   The booking becomes paid only when Stripe says so, on the signed webhook (checkout.session.completed). The page
   the client returns to just shows that status; it never marks anything paid itself.

   Without STRIPE_SECRET_KEY, outside production, checkout is a fake "paid" link (/api/dev/pay/<token>) so the whole
   flow can be tried locally. In production without a key, booking is refused with a clear message.
   ===================================================================== */
const crypto = require('crypto');
const config = require('./config');

/** Stripe wants form encoding with brackets for nested fields: line_items[0][price_data][currency]=usd. */
function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

async function stripe(method, pathname, params, idempotencyKey) {
  const headers = { Authorization: `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch('https://api.stripe.com/v1' + pathname, { method, headers, body: params ? formEncode(params) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `Stripe ${r.status}`);
  return data;
}

const enabled = () => !!config.stripeSecretKey;
// The pretend checkout: while building, and always in the demo (which never takes real money).
const devMode = () => !enabled() && (!config.isProd || config.demo);

/**
 * Starts payment of the deposit. Returns { url, sessionId } — url is where to send the client.
 * Throws a plain-English Error if payments can't be taken.
 */
async function startCheckout(booking, pkg, idempotencyKey) {
  if (devMode()) return { url: `/api/dev/pay/${booking.token}`, sessionId: null };
  if (!enabled()) throw new Error('Online booking isn’t open yet. Please email to book.');
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: booking.client_email,
    client_reference_id: booking.token,
    metadata: { booking: booking.token, kind: 'deposit' },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: booking.deposit_cents, product_data: { name: `Deposit: ${pkg.name} session` } } }],
    success_url: `${config.baseUrl}/booked?b=${booking.token}`,
    cancel_url: `${config.baseUrl}/book?p=${encodeURIComponent(pkg.slug)}&released=${booking.token}`,
    expires_at: Math.floor(new Date(booking.hold_expires_at).getTime() / 1000),
  }, 'checkout-' + idempotencyKey);
  return { url: session.url, sessionId: session.id };
}

/**
 * Starts payment of the balance, from the client's gallery. Paid, it unlocks their clean photos (webhook, kind
 * 'balance'). Returns { url, sessionId }.
 */
async function startBalanceCheckout(booking, pkg, idempotencyKey) {
  const due = booking.price_cents - booking.deposit_cents;
  if (devMode()) return { url: `/api/dev/pay-balance/${booking.token}`, sessionId: null };
  if (!enabled()) throw new Error('Online payment isn\u2019t open yet. Please pay in person.');
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: booking.client_email,
    client_reference_id: booking.token,
    metadata: { booking: booking.token, kind: 'balance' },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: due, product_data: { name: `Balance: ${pkg.name} session` } } }],
    success_url: `${config.baseUrl}/gallery/${booking.token}?paid=1`,
    cancel_url: `${config.baseUrl}/gallery/${booking.token}`,
  }, 'balance-' + idempotencyKey);
  return { url: session.url, sessionId: session.id };
}

/**
 * Checks a webhook's Stripe-Signature header against the raw body. Returns the parsed event, or null if it's not
 * genuine (or older than 5 minutes, so a captured one can't be replayed).
 */
function verifyWebhook(rawBody, header, secret = config.stripeWebhookSecret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return null;
  const parts = {};
  for (const kv of String(header).split(',')) { const [k, v] = kv.split('='); (parts[k] = parts[k] || []).push(v); }
  const t = parseInt((parts.t || [])[0], 10);
  if (!t || Math.abs(nowSec - t) > 300) return null;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = (parts.v1 || []).some((sig) => sig && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch (e) { return null; }
}

module.exports = { startBalanceCheckout, startCheckout, verifyWebhook, enabled, devMode, formEncode };

'use strict';
/* =====================================================================
   mail.js — every email the site sends, and the outbox that sends them.

   Nothing is sent inline. queue() writes the email to the outbox; the job loop (jobs.js) sends what's due. So a slow
   or failing mail service never slows a page, a failed send is retried, and the outbox's unique index means the same
   email (say, the 3-day reminder) can never go to a client twice.

   A queued email can wait (`delayMs`) before it's sent. That's how Admin's Undo works for actions that email the
   client (deliver, cancel): the email waits 10 seconds, and Undo takes it back out before it leaves.

   Sending: with RESEND_API_KEY set, through Resend's API. Without it, printed to the console (development).
   ===================================================================== */
const db = require('./db');
const config = require('./config');

const MAX_ATTEMPTS = 5;
const sentInTests = []; // what would have gone out, when NODE_ENV=test

function when(b) {
  const tz = config.timezone;
  const start = new Date(b.start_at); const end = new Date(b.end_at);
  const day = start.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  const t = (d) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(start)} to ${t(end)}`;
}
const money = (cents) => '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

/** The subject and body for one kind of email. Plain text: it reads well everywhere and never lands in Promotions. */
function compose(kind, b, pkg) {
  const biz = config.businessName;
  const prepLink = `${config.baseUrl}/prep/${b.token}`;
  const statusLink = `${config.baseUrl}/booked?b=${b.token}`;
  const balance = money(b.price_cents - b.deposit_cents);
  const sign = `\n\n${biz}`;
  switch (kind) {
    case 'confirmation': return {
      to: b.client_email,
      subject: `You’re booked: ${pkg.name}, ${when(b)}`,
      body: `Hi ${first(b.client_name)},\n\nYour ${pkg.name} session is booked for ${when(b)}. Your ${money(b.deposit_cents)} deposit is in, and the ${balance} balance is due at the shoot.\n\nOne thing to do now: tell me about the shoot (location idea, the look you want, who or what we’re shooting). It takes two minutes:\n${prepLink}\n\nYour booking: ${statusLink}${sign}`,
    };
    case 'admin_new': return {
      to: config.adminEmail,
      subject: `New booking: ${b.client_name}, ${pkg.name}, ${when(b)}`,
      body: `${b.client_name} (${b.client_email}${b.client_phone ? ', ' + b.client_phone : ''}) booked ${pkg.name} for ${when(b)}.\nDeposit paid: ${money(b.deposit_cents)}.\n${b.notes ? '\nTheir note: ' + b.notes + '\n' : ''}\n${config.baseUrl}/admin`,
    };
    case 'reminder3': return {
      to: b.client_email,
      subject: `3 days to your ${pkg.name} session`,
      body: `Hi ${first(b.client_name)},\n\nYour session is ${when(b)}.\n\nWhat helps: outfits laid out the night before (solid colours photograph best), and arriving 10 minutes early. We’re shooting at golden hour, so the time is set by the sun and can’t slide.${b.prepped_at ? '' : `\n\nIf you haven’t yet, tell me about the shoot here:\n${prepLink}`}${sign}`,
    };
    case 'reminder1': return {
      to: b.client_email,
      subject: `Tomorrow: your ${pkg.name} session`,
      body: `Hi ${first(b.client_name)},\n\nSee you ${when(b)}.${prepLocation(b) ? `\nWhere: ${prepLocation(b)}` : ''}\n\nI’ll check the weather in the morning and message you if anything changes.${sign}`,
    };
    case 'gallery': return {
      to: b.client_email,
      subject: `Your photos are ready`,
      body: `Hi ${first(b.client_name)},\n\nYour ${pkg.name} photos are ready:\n${b.gallery_url}\n\nDownload the ones you love, or all of them at once, and keep a copy somewhere safe.${sign}`,
    };
    case 'review': return {
      to: b.client_email,
      subject: `How did your photos turn out?`,
      body: `Hi ${first(b.client_name)},\n\nI hope you’re loving your photos. If you have a minute, a short review helps more than you’d think. Just reply to this email with a sentence or two.\n\nWhenever you want another session: ${config.baseUrl}/book${sign}`,
    };
    case 'cancelled': return {
      to: b.client_email,
      subject: `Your session on ${when(b)} is cancelled`,
      body: `Hi ${first(b.client_name)},\n\nYour ${pkg.name} session on ${when(b)} has been cancelled. If that’s a surprise, just reply to this email.${sign}`,
    };
    case 'admin_needs_refund': return {
      to: config.adminEmail,
      subject: `Action needed: refund ${b.client_name}`,
      body: `${b.client_name} paid a ${money(b.deposit_cents)} deposit after their hold ran out, and the time (${when(b)}) had already gone to someone else.\nRefund them in Stripe (session ${b.stripe_session_id || 'unknown'}) and offer another date.\n\n${config.baseUrl}/admin`,
    };
    default: throw new Error('Unknown email: ' + kind);
  }
}
function prepLocation(b) {
  try { return (JSON.parse(b.prep_json || '{}').location || '').trim(); } catch (e) { return ''; }
}

/** Puts an email in the outbox. Returns false when it was already queued (or sent) for this booking. */
function queue(kind, booking, { delayMs = 0 } = {}) {
  const pkg = db.get('SELECT * FROM packages WHERE id = ?', [booking.package_id]);
  const m = compose(kind, booking, pkg);
  if (!m.to) return false; // e.g. no ADMIN_EMAIL set
  if (db.get("SELECT 1 FROM outbox WHERE booking_id = ? AND kind = ? AND status != 'cancelled'", [booking.id, kind])) return false;
  const now = Date.now();
  db.run('INSERT INTO outbox (booking_id, kind, to_addr, subject, body, send_after, created_at) VALUES (?,?,?,?,?,?,?)',
    [booking.id, kind, m.to, m.subject, m.body, new Date(now + delayMs).toISOString(), new Date(now).toISOString()]);
  return true;
}

/** Takes a waiting email back out (Undo). True if it hadn't been sent yet. */
function unqueue(kind, bookingId) {
  return db.run("UPDATE outbox SET status = 'cancelled' WHERE booking_id = ? AND kind = ? AND status = 'pending'", [bookingId, kind]).changes > 0;
}

async function deliver(m) {
  if (config.isTest) { sentInTests.push(m); return; }
  if (!config.resendApiKey) {
    console.log(`\n--- email (not sent: no RESEND_API_KEY) ---\nTo: ${m.to_addr}\nSubject: ${m.subject}\n\n${m.body}\n---\n`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `outbox-${m.id}` },
    body: JSON.stringify({ from: config.mailFrom || `${config.businessName} <onboarding@resend.dev>`, to: [m.to_addr], reply_to: config.adminEmail || undefined, subject: m.subject, text: m.body }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Sends what's due. Called by the job loop. */
async function processOutbox(now = new Date()) {
  const due = db.all("SELECT * FROM outbox WHERE status = 'pending' AND send_after <= ? ORDER BY id LIMIT 20", [now.toISOString()]);
  for (const m of due) {
    try {
      await deliver(m);
      db.run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?", [new Date().toISOString(), m.id]);
    } catch (e) {
      const attempts = m.attempts + 1;
      // Wait longer after each failure: 1, 4, 9, 16 minutes.
      db.run('UPDATE outbox SET attempts = ?, last_error = ?, status = ?, send_after = ? WHERE id = ?',
        [attempts, String(e.message).slice(0, 300), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', new Date(Date.now() + attempts * attempts * 60000).toISOString(), m.id]);
      console.error('email failed:', m.kind, e.message);
    }
  }
  return due.length;
}

module.exports = { queue, unqueue, processOutbox, compose, when, money, sentInTests };

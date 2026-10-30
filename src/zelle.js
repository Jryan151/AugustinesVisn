'use strict';
/* =====================================================================
   zelle.js — taking the deposit and the balance by Zelle: no fees.

   Zelle has no way to tell a website that money arrived, so the photographer confirms each payment, in one tap:
     1. The client sees who to pay, the exact amount, and a short reference (AV-4K7Q) to put in the memo.
     2. They tap "I've sent it". The photographer gets an email with the reference and a Confirm link.
     3. The photographer checks their bank app and taps Confirm (in that email, or in Admin).
        Deposit: the booking is confirmed. Balance: the clean photos unlock. Either way the client is emailed,
        10 seconds later, so Undo still works.

   A Zelle booking holds its time for longer than a card one (holdHours, 24 by default), since the money is checked
   by hand; when the client says they've sent it, the hold stretches to at least 48 hours from then, so a time is
   never released while the photographer is about to confirm.

   The Confirm link is signed (HMAC with SESSION_SECRET), names one booking and one payment, and expires after
   14 days. It opens a page with a button, rather than confirming on open, because email apps open links by themselves
   to scan them.
   ===================================================================== */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const media = require('./media');
const { HttpError } = require('./http');

const SENT_HOLD_HOURS = 48;
const LINK_DAYS = 14;
const WHATS = ['deposit', 'balance'];

function settings() { return Object.assign({ enabled: false, recipient: '', name: '', holdHours: 24, qr: null }, (db.setting('payments') || {}).zelle); }
const enabled = () => { const z = settings(); return !!(z.enabled && z.recipient); };

/** What a client needs to pay: who, and (if uploaded) the QR code their bank app scans. */
function publicInfo() {
  const z = settings();
  if (!enabled()) return null;
  return { recipient: z.recipient, name: z.name, qr: z.qr ? { url: '/media/' + z.qr.web, width: z.qr.width, height: z.qr.height } : null };
}

function saveSettings(body) {
  const z = settings();
  const recipient = String(body.recipient == null ? z.recipient : body.recipient).trim().slice(0, 120);
  const name = String(body.name == null ? z.name : body.name).trim().slice(0, 80);
  const holdHours = Number(body.holdHours == null ? z.holdHours : body.holdHours);
  if (!Number.isInteger(holdHours) || holdHours < 1 || holdHours > 168) throw new HttpError(400, 'Hold time must be 1 to 168 hours.');
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient);
  const isPhone = /^\+?[\d\s().-]{10,20}$/.test(recipient);
  if (recipient && !isEmail && !isPhone) throw new HttpError(400, 'The Zelle recipient is the email or phone number your Zelle is registered to.');
  const on = body.enabled === undefined ? z.enabled : body.enabled === true;
  if (on && !recipient) throw new HttpError(400, 'Add your Zelle email or phone number first.');
  save(Object.assign({}, z, { enabled: on, recipient, name, holdHours }));
  return settings();
}
function save(z) { db.saveSetting('payments', Object.assign({}, db.setting('payments'), { zelle: z })); }

async function setQr(req) {
  const f = await media.storeUpload(req, config.mediaDir);
  const z = settings();
  if (z.qr) media.removeFiles(config.mediaDir, z.qr);
  save(Object.assign({}, z, { qr: f }));
  return settings();
}
function removeQr() {
  const z = settings();
  if (z.qr) media.removeFiles(config.mediaDir, z.qr);
  save(Object.assign({}, z, { qr: null }));
  return settings();
}

/* ---------- the reference in the memo ---------- */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read back from a bank app
function newRef() {
  for (;;) {
    const bytes = crypto.randomBytes(4);
    const code = 'AV-' + [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!db.get('SELECT 1 FROM bookings WHERE ref_code = ?', [code])) return code;
  }
}
/** The booking's reference, made the first time it's needed. */
function refFor(b) {
  if (b.ref_code) return b.ref_code;
  const code = newRef();
  db.run('UPDATE bookings SET ref_code = ? WHERE id = ? AND ref_code IS NULL', [code, b.id]);
  return db.get('SELECT ref_code FROM bookings WHERE id = ?', [b.id]).ref_code;
}

/* ---------- the signed Confirm link ---------- */
const sign = (s) => crypto.createHmac('sha256', config.sessionSecret).update('zelle:' + s).digest('base64url').slice(0, 32);
function confirmCode(bookingId, what, now = Date.now()) {
  const body = `${bookingId}.${what}.${Math.floor(now / 1000) + LINK_DAYS * 86400}`;
  return `${body}.${sign(body)}`;
}
/** The booking and payment a Confirm code names, or a plain-English error. */
function readCode(code, now = Date.now()) {
  const m = /^(\d{1,10})\.(deposit|balance)\.(\d{10})\.([A-Za-z0-9_-]{32})$/.exec(String(code || ''));
  if (!m) throw new HttpError(404, 'That link isn’t right. Open it from the email again.');
  const body = `${m[1]}.${m[2]}.${m[3]}`;
  const want = Buffer.from(sign(body)); const given = Buffer.from(m[4]);
  if (want.length !== given.length || !crypto.timingSafeEqual(want, given)) throw new HttpError(404, 'That link isn’t right. Open it from the email again.');
  if (Number(m[3]) * 1000 < now) throw new HttpError(410, 'That link has expired. Confirm it in Admin instead.');
  const b = db.get('SELECT * FROM bookings WHERE id = ?', [Number(m[1])]);
  if (!b) throw new HttpError(404, 'That booking no longer exists.');
  return { b, what: m[2] };
}
const confirmUrl = (bookingId, what) => `${config.baseUrl}/confirm/${confirmCode(bookingId, what)}`;

/* ---------- the client says they've sent it ---------- */
/**
 * The client tapped "I've sent it". Records it, keeps their time held, and emails the photographer the reference and
 * the Confirm link (once per payment). Safe to tap twice.
 */
function clientSent(b, what, now = new Date()) {
  if (!enabled()) throw new HttpError(400, 'Zelle isn’t available right now.');
  if (what === 'deposit') {
    if (b.status !== 'hold' && b.status !== 'expired') throw new HttpError(400, 'This deposit is already sorted.');
    if (b.status === 'expired') throw new HttpError(410, 'This hold has run out. Pick a time again.');
    if (!b.zelle_sent_at) {
      const until = new Date(Math.max(new Date(b.hold_expires_at).getTime(), now.getTime() + SENT_HOLD_HOURS * 3600000)).toISOString();
      db.run("UPDATE bookings SET zelle_sent_at = ?, hold_expires_at = ?, pay_method = 'zelle', updated_at = ? WHERE id = ?", [now.toISOString(), until, now.toISOString(), b.id]);
    }
    refFor(b);
    mail.queue('admin_zelle_deposit', db.get('SELECT * FROM bookings WHERE id = ?', [b.id]));
  } else {
    if (b.balance_paid_at) throw new HttpError(400, 'This balance is already paid.');
    if (!b.balance_zelle_sent_at) db.run('UPDATE bookings SET balance_zelle_sent_at = ?, updated_at = ? WHERE id = ?', [now.toISOString(), now.toISOString(), b.id]);
    refFor(b);
    mail.queue('admin_zelle_balance', db.get('SELECT * FROM bookings WHERE id = ?', [b.id]));
  }
  return db.get('SELECT * FROM bookings WHERE id = ?', [b.id]);
}

/** What the Confirm page shows: who, what, how much, and whether it's still to do. */
function describe(b, what) {
  const pkg = db.get('SELECT name FROM packages WHERE id = ?', [b.package_id]);
  const amount = what === 'deposit' ? b.deposit_cents : b.price_cents - b.deposit_cents;
  const done = what === 'deposit' ? !['hold', 'expired'].includes(b.status) : !!b.balance_paid_at;
  return {
    what, done, status: b.status, client: b.client_name, package: pkg.name, when: mail.when(b), amountCents: amount, ref: b.ref_code || refFor(b),
    sentAt: what === 'deposit' ? b.zelle_sent_at : b.balance_zelle_sent_at,
    unavailable: what === 'deposit' && b.status === 'cancelled',
  };
}

module.exports = { settings, enabled, publicInfo, saveSettings, setQr, removeQr, refFor, clientSent, confirmCode, confirmUrl, readCode, describe, SENT_HOLD_HOURS };

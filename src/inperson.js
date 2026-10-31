'use strict';
/* =====================================================================
   inperson.js — booking without paying online: the client pays the photographer in person, at the shoot.

   With no money up front, the only thing that stops someone filling the calendar with made-up names is proof that
   they're a real person at a real email address. So:
     1. start()  — the client sends their details. Nothing is held yet. A 6-digit code goes to their email.
     2. verify() — they type the code. Only now is the time booked, and only if it's still free.
   A time can't be tied up by anyone who doesn't open the email. The code works for 15 minutes and 5 tries; one email
   address can ask for at most 3 codes in 30 minutes. The code itself is never stored, only a hash of it.

   The booking is stored with a $0 deposit, so the whole price is the balance: due in person, marked paid in Admin,
   and the photos stay watermarked until then, exactly like any other unpaid balance.
   ===================================================================== */
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const config = require('./config');
const availability = require('./availability');
const { HttpError } = require('./http');

const CODE_MINUTES = 15;
const MAX_TRIES = 5;
const MAX_CODES = 3; // per email address, per 30 minutes

const settings = () => Object.assign({ enabled: true }, (db.setting('payments') || {}).inPerson);
const enabled = () => settings().enabled !== false;
function saveSettings(body) {
  if (body && body.enabled !== undefined) db.saveSetting('payments', Object.assign({}, db.setting('payments'), { inPerson: { enabled: body.enabled === true } }));
  return settings();
}

const hash = (token, code) => crypto.createHash('sha256').update(`${token}:${code}`).digest('hex');
const mask = (email) => email.replace(/^(.)[^@]*(@.*)$/, (m, a, b) => `${a}•••${b}`);

/** Step 1: checks the time is free right now, then emails a code. Returns { verify, email } (the email masked). */
function start({ pkg, slotKey, name, email, phone, notes }, now = new Date()) {
  if (!availability.findSlot(pkg, slotKey, now)) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
  const since = new Date(now.getTime() - 30 * 60000).toISOString();
  if (db.get('SELECT COUNT(*) n FROM email_checks WHERE email = ? AND created_at > ?', [email, since]).n >= MAX_CODES) {
    throw new HttpError(429, 'Too many codes for this email. Use the newest one, or try again in half an hour.');
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.run('INSERT INTO email_checks (token, email, payload, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    [token, email, JSON.stringify({ packageId: pkg.id, slotKey, name, phone, notes }), hash(token, code),
      new Date(now.getTime() + CODE_MINUTES * 60000).toISOString(), now.toISOString()]);
  mail.queueNote({
    kind: 'booking_code', to: email,
    subject: `${code} is your booking code`,
    body: `Hi ${String(name).split(/\s+/)[0] || 'there'},\n\nYour code to book ${pkg.name} is:\n\n${code}\n\nType it on the booking page to confirm your time. It works for ${CODE_MINUTES} minutes.\nDidn’t ask for this? Ignore this email and nothing is booked.\n\n${config.businessName}`,
  });
  // Codes can't wait for the next run of the email loop: send now (still through the outbox, so nothing is lost).
  mail.processOutbox().catch((e) => console.error('outbox:', e.message));
  return { verify: token, email: mask(email) };
}

/** Step 2: the right code books the time (if it's still free). Returns the new booking. */
function verify(token, code, now = new Date()) {
  const c = /^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? db.get('SELECT * FROM email_checks WHERE token = ?', [token]) : null;
  if (!c) throw new HttpError(404, 'That code request wasn’t found. Start again.');
  if (c.booking_token) return require('./bookings').byToken(c.booking_token); // already booked: the same answer again
  if (c.attempts >= MAX_TRIES) throw new HttpError(429, 'Too many wrong codes. Send yourself a new one.');
  if (new Date(c.expires_at) < now) throw new HttpError(410, 'That code has run out. Send yourself a new one.');
  const given = String(code || '').replace(/\D/g, '');
  const ok = given.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(token, given)), Buffer.from(c.code_hash));
  if (!ok) {
    db.run('UPDATE email_checks SET attempts = attempts + 1 WHERE token = ?', [token]);
    const left = MAX_TRIES - c.attempts - 1;
    throw new HttpError(400, left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Send yourself a new one.', { field: 'code' });
  }
  const p = JSON.parse(c.payload);
  const pkg = db.get('SELECT * FROM packages WHERE id = ? AND active = 1', [p.packageId]);
  if (!pkg) throw new HttpError(404, 'That package isn’t available any more.');
  const b = require('./bookings').createInPerson({ pkg, slotKey: p.slotKey, name: p.name, email: c.email, phone: p.phone, notes: p.notes }, now);
  db.run('UPDATE email_checks SET booking_token = ? WHERE token = ?', [b.token, token]);
  return b;
}

/** Old code requests (over a day) are cleared by the job loop. */
const purge = (now = new Date()) => db.run('DELETE FROM email_checks WHERE created_at < ?', [new Date(now.getTime() - 86400000).toISOString()]).changes;

module.exports = { enabled, settings, saveSettings, start, verify, purge, CODE_MINUTES };

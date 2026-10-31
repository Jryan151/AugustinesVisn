'use strict';
/* =====================================================================
   bookings.js — a booking's life, from hold to delivered.

     hold ──(Stripe confirms the deposit)──> booked ──(client fills in prep)──> prepped ──> shot ──> editing ──> delivered
       └──(payment window passes)──> expired           any live status ──(photographer cancels)──> cancelled
     expired ──(a late payment arrives, but the time went to someone else)──> needs_refund

   Rules that hold everywhere:
   - Only Stripe's webhook makes a booking paid (markPaid). Nothing the client's browser says can.
   - One live booking per time: checked here, enforced by the database's unique index.
   - Every email goes through the outbox (mail.queue), at most once per kind per booking.
   ===================================================================== */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const availability = require('./availability');
const zelle = require('./zelle');
const { HttpError } = require('./http');

const UNDO_MS = 10000; // how long an emailing action waits, so Undo can take it back

const byId = (id) => db.get('SELECT * FROM bookings WHERE id = ?', [id]);
const byToken = (token) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? db.get('SELECT * FROM bookings WHERE token = ?', [token]) : undefined);
const isUniqueClash = (e) => /UNIQUE constraint failed: bookings/.test(String(e && e.message));

function expireStaleHolds(now = new Date()) {
  return db.run("UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'hold' AND hold_expires_at < ?", [now.toISOString(), now.toISOString()]).changes;
}

/** Holds a time for a client while they pay. Throws 409 if the time can't be had any more. */
/**
 * Holds a time for a client while they pay. `method` is 'card' (Stripe: held 30 minutes) or 'zelle' (held for the
 * photographer's Zelle hold time, since each Zelle payment is checked by hand). Throws 409 if the time is gone.
 */
function createHold({ pkg, slotKey, name, email, phone, notes, method = 'card' }, now = new Date()) {
  expireStaleHolds(now);
  const slot = availability.findSlot(pkg, slotKey, now);
  if (!slot) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
  const p = availability.parseSlotKey(slotKey);
  const iso = now.toISOString();
  const holdMs = method === 'zelle' ? zelle.settings().holdHours * 3600000 : config.holdMinutes * 60000;
  try {
    const r = db.run(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email,
        client_phone, notes, price_cents, deposit_cents, hold_expires_at, pay_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'hold', ?,?,?,?,?,?,?,?,?,?)`,
      [crypto.randomBytes(18).toString('base64url'), pkg.id, slotKey, p.date, p.period, slot.start, slot.end, name, email, phone, notes,
        pkg.price_cents, pkg.deposit_cents, new Date(now.getTime() + holdMs).toISOString(), method, iso, iso]);
    const b = byId(r.lastInsertRowid);
    if (method === 'zelle') { zelle.refFor(b); mail.queue('zelle_deposit', byId(b.id)); }
    return byId(b.id);
  } catch (e) {
    if (isUniqueClash(e)) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
    throw e;
  }
}

/**
 * An in-person booking, made once the client has typed the code from their email (inperson.js). Booked straight
 * away, with a $0 deposit: the whole price is the balance, paid at the shoot and marked paid in Admin.
 */
function createInPerson({ pkg, slotKey, name, email, phone, notes }, now = new Date()) {
  expireStaleHolds(now);
  const slot = availability.findSlot(pkg, slotKey, now);
  if (!slot) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
  const p = availability.parseSlotKey(slotKey);
  const iso = now.toISOString();
  try {
    const r = db.run(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email,
        client_phone, notes, price_cents, deposit_cents, pay_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'booked', ?,?,?,?,?, 0, 'in_person', ?,?)`,
      [crypto.randomBytes(18).toString('base64url'), pkg.id, slotKey, p.date, p.period, slot.start, slot.end, name, email, phone || '', notes || '',
        pkg.price_cents, iso, iso]);
    const b = byId(r.lastInsertRowid);
    mail.queue('confirmation', b);
    mail.queue('admin_new', b);
    return b;
  } catch (e) {
    if (isUniqueClash(e)) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
    throw e;
  }
}

/** Gives up a hold whose checkout couldn't be started, so the time is free again at once. */
function releaseHold(id) {
  db.run("UPDATE bookings SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'hold'", [db.nowIso(), id]);
}

function attachCheckout(id, sessionId) {
  if (sessionId) db.run('UPDATE bookings SET stripe_session_id = ? WHERE id = ?', [sessionId, id]);
}

/**
 * The deposit is paid (from Stripe's webhook, or the dev pay link). Safe to call twice: Stripe retries webhooks.
 * Returns the booking's status afterwards.
 */
function markPaid(token, sessionId, now = new Date(), { byPhotographer = false } = {}) {
  const b = byToken(token);
  if (!b) return null;
  if (b.status !== 'hold' && b.status !== 'expired') return b.status; // already handled
  const iso = now.toISOString();
  return db.tx(() => {
    try {
      db.run("UPDATE bookings SET status = 'booked', paid_at = ?, stripe_session_id = COALESCE(?, stripe_session_id), hold_expires_at = NULL, updated_at = ? WHERE id = ?",
        [iso, sessionId || null, iso, b.id]);
    } catch (e) {
      if (!isUniqueClash(e)) throw e;
      // They paid after their hold ran out and someone else has the time now. Never double-book: flag a refund.
      db.run("UPDATE bookings SET status = 'needs_refund', paid_at = ?, stripe_session_id = COALESCE(?, stripe_session_id), updated_at = ? WHERE id = ?",
        [iso, sessionId || null, iso, b.id]);
      mail.queue('admin_needs_refund', byId(b.id));
      return 'needs_refund';
    }
    const fresh = byId(b.id);
    // Confirmed by the photographer (Zelle): the client's email waits, for Undo, and the photographer needs no notice.
    mail.queue('confirmation', fresh, { delayMs: byPhotographer ? UNDO_MS : 0 });
    if (!byPhotographer) mail.queue('admin_new', fresh);
    return 'booked';
  });
}

const PREP_FIELDS = { location: 300, look: 1000, who: 500, references: 1000, other: 1000 };
/** The client's prep questionnaire. Moves a booked session to prepped. Can be updated until the shoot. */
function savePrep(token, answers) {
  const b = byToken(token);
  if (!b || !['booked', 'prepped'].includes(b.status)) throw new HttpError(404, 'This booking can’t take answers any more.');
  const clean = {};
  for (const [k, max] of Object.entries(PREP_FIELDS)) clean[k] = String(answers[k] == null ? '' : answers[k]).trim().slice(0, max);
  if (!clean.location && !clean.look && !clean.who) throw new HttpError(400, 'Fill in at least the location, the look, or who we’re shooting.');
  const iso = db.nowIso();
  db.run("UPDATE bookings SET prep_json = ?, prepped_at = COALESCE(prepped_at, ?), status = 'prepped', updated_at = ? WHERE id = ?", [JSON.stringify(clean), iso, iso, b.id]);
  return byToken(token);
}

/* ---------- the photographer's moves (Admin) ---------- */

// Moves that send nothing, so Undo is just moving back.
const PLAIN_MOVES = ['booked', 'prepped', 'shot', 'editing'];
function setStatus(id, status) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (!PLAIN_MOVES.includes(status) || !PLAIN_MOVES.includes(b.status)) throw new HttpError(400, `Can’t move a ${b.status} booking to ${status} here.`);
  db.run('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?', [status, db.nowIso(), id]);
  return byId(id);
}

/**
 * Delivered: queues the gallery email (it waits a few seconds, for Undo). With no link given, it sends the photos
 * uploaded here (the client's /gallery/<token> page); with a link, it sends that (a gallery hosted elsewhere).
 */
function deliver(id, galleryUrl) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (!['shot', 'editing', 'prepped', 'booked'].includes(b.status)) throw new HttpError(400, `A ${b.status} booking can\u2019t be delivered.`);
  let link;
  if (String(galleryUrl || '').trim()) {
    let url;
    try { url = new URL(String(galleryUrl).trim()); } catch (e) { url = null; }
    if (!url || url.protocol !== 'https:') throw new HttpError(400, 'Paste the gallery\u2019s full link (starting with https://).');
    link = url.href;
  } else {
    if (!require('./galleries').count(id)) throw new HttpError(400, 'Upload the photos first, or paste a gallery link.');
    link = `${config.baseUrl}/gallery/${b.token}`;
  }
  const iso = db.nowIso();
  return db.tx(() => {
    db.run("UPDATE bookings SET status = 'delivered', gallery_url = ?, delivered_at = ?, updated_at = ? WHERE id = ?", [link, iso, iso, id]);
    mail.queue('gallery', byId(id), { delayMs: UNDO_MS });
    return { booking: byId(id), previous: b.status };
  });
}

function cancel(id) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (!db.ACTIVE.includes(b.status)) throw new HttpError(400, `This booking is already ${b.status}.`);
  const iso = db.nowIso();
  return db.tx(() => {
    db.run("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?", [iso, iso, id]);
    if (b.status !== 'hold') mail.queue('cancelled', byId(id), { delayMs: UNDO_MS });
    return { booking: byId(id), previous: b.status };
  });
}

/* ---------- the balance: paying it unlocks the clean, full-quality photos ---------- */

/** Nothing left to pay (balance paid, or a package with no balance) means the clean photos are open to the client. */
const isUnlocked = (b) => !!b.balance_paid_at || b.price_cents - b.deposit_cents <= 0;

/**
 * The balance is paid: `by` is 'online' (Stripe's webhook) or 'marked' (the photographer, in Admin). Safe to call
 * twice. If the gallery has already been sent, the client is emailed that their photos are unlocked; for a mark by
 * the photographer that email waits a few seconds, for Undo.
 */
function markBalancePaid(b, by, sessionId) {
  if (!b) throw new HttpError(404, 'No such booking.');
  if (!['booked', 'prepped', 'shot', 'editing', 'delivered'].includes(b.status)) throw new HttpError(400, `A ${b.status} booking has no balance to take.`);
  if (b.balance_paid_at) return byId(b.id);
  const iso = db.nowIso();
  return db.tx(() => {
    db.run('UPDATE bookings SET balance_paid_at = ?, balance_paid_by = ?, balance_session_id = COALESCE(?, balance_session_id), updated_at = ? WHERE id = ?',
      [iso, by, sessionId || null, iso, b.id]);
    const fresh = byId(b.id);
    if (fresh.status === 'delivered') mail.queue('unlocked', fresh, { delayMs: by === 'online' ? 0 : UNDO_MS });
    return fresh;
  });
}

/** Undo for deliver, cancel and "balance paid": only while their email hasn't left. */
function undo(id, action, previous) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (action === 'zelle') {
    // A Zelle deposit confirmed by mistake: back to waiting for it, while the confirmation hasn't left.
    if (b.status !== 'booked' || b.pay_method !== 'zelle') throw new HttpError(400, 'Nothing to undo.');
    return db.tx(() => {
      if (!mail.unqueue('confirmation', id)) throw new HttpError(409, 'Too late to undo: the client has already been told.');
      db.run("UPDATE bookings SET status = 'hold', paid_at = NULL, hold_expires_at = ?, updated_at = ? WHERE id = ?",
        [new Date(Date.now() + zelle.SENT_HOLD_HOURS * 3600000).toISOString(), db.nowIso(), id]);
      return byId(id);
    });
  }
  if (action === 'balance') {
    if (!b.balance_paid_at || !['marked', 'zelle'].includes(b.balance_paid_by)) throw new HttpError(400, 'Nothing to undo.');
    return db.tx(() => {
      const pulled = mail.unqueue('unlocked', id);
      if (!pulled && db.get("SELECT 1 FROM outbox WHERE booking_id = ? AND kind = 'unlocked' AND status = 'sent'", [id])) {
        throw new HttpError(409, 'Too late to undo: the client has already been told.');
      }
      db.run('UPDATE bookings SET balance_paid_at = NULL, balance_paid_by = NULL, updated_at = ? WHERE id = ?', [db.nowIso(), id]);
      return byId(id);
    });
  }
  if (!db.ACTIVE.includes(previous)) throw new HttpError(400, 'Nothing to undo.');
  const kind = action === 'deliver' ? 'gallery' : action === 'cancel' ? 'cancelled' : null;
  const expected = action === 'deliver' ? 'delivered' : 'cancelled';
  if (!kind || b.status !== expected) throw new HttpError(400, 'Nothing to undo.');
  return db.tx(() => {
    const pulled = mail.unqueue(kind, id);
    const hadEmail = previous !== 'hold' || action !== 'cancel';
    if (hadEmail && !pulled) throw new HttpError(409, 'Too late to undo: the email has already gone.');
    try {
      if (action === 'deliver') db.run('UPDATE bookings SET status = ?, gallery_url = NULL, delivered_at = NULL, updated_at = ? WHERE id = ?', [previous, db.nowIso(), id]);
      else db.run('UPDATE bookings SET status = ?, cancelled_at = NULL, updated_at = ? WHERE id = ?', [previous, db.nowIso(), id]);
    } catch (e) {
      if (isUniqueClash(e)) throw new HttpError(409, 'Someone else booked that time in the meantime.');
      throw e;
    }
    return byId(id);
  });
}

/** The photographer confirms a Zelle payment arrived: the deposit (confirms the booking) or the balance (unlocks). */
function confirmZelle(b, what) {
  if (what === 'deposit') {
    if (!['hold', 'expired'].includes(b.status)) return byId(b.id);
    if (b.pay_method !== 'zelle') db.run("UPDATE bookings SET pay_method = 'zelle' WHERE id = ?", [b.id]);
    markPaid(b.token, null, new Date(), { byPhotographer: true });
    return byId(b.id);
  }
  return markBalancePaid(b, 'zelle');
}

/* ---------- views ---------- */

/** What the client may see about their own booking (by its private token). */
function publicView(b) {
  const pkg = db.get('SELECT name, minutes, photos, turnaround_days FROM packages WHERE id = ?', [b.package_id]);
  return {
    status: b.status === 'hold' && new Date(b.hold_expires_at) < new Date() ? 'expired' : b.status,
    package: pkg, period: b.period, start: b.start_at, end: b.end_at, when: mail.when(b),
    name: b.client_name, depositCents: b.deposit_cents, balanceCents: b.price_cents - b.deposit_cents,
    prepped: !!b.prepped_at, prep: b.prep_json ? JSON.parse(b.prep_json) : null,
    galleryUrl: b.status === 'delivered' ? b.gallery_url : null,
    unlocked: isUnlocked(b),
    payMethod: b.pay_method, ref: b.ref_code, holdExpiresAt: b.status === 'hold' ? b.hold_expires_at : null,
    zelleSent: !!b.zelle_sent_at, balanceZelleSent: !!b.balance_zelle_sent_at,
  };
}

function adminList() {
  return db.all(`SELECT b.*, p.name AS package_name,
      (SELECT COUNT(*) FROM photos ph WHERE ph.booking_id = b.id AND ph.deleted_at IS NULL) AS photo_count
    FROM bookings b JOIN packages p ON p.id = b.package_id
    WHERE b.status != 'expired' AND (b.status != 'hold' OR (b.pay_method = 'zelle' AND b.hold_expires_at > ?)) AND (b.status != 'cancelled' OR b.cancelled_at > ?)
    ORDER BY b.start_at`, [new Date().toISOString(), new Date(Date.now() - 30 * 86400000).toISOString()])
    .map((b) => Object.assign(b, { prep: b.prep_json ? JSON.parse(b.prep_json) : null, when: mail.when(b) }));
}

/* ---------- idempotency: a request key answered once is answered the same way again ---------- */
function recall(key) {
  const r = db.get('SELECT status, body FROM idempotency WHERE key = ?', [key]);
  return r ? { status: r.status, body: JSON.parse(r.body) } : null;
}
function remember(key, status, body) {
  db.run('INSERT OR IGNORE INTO idempotency (key, status, body, created_at) VALUES (?,?,?,?)', [key, status, JSON.stringify(body), db.nowIso()]);
}

module.exports = { createInPerson, confirmZelle, isUnlocked, markBalancePaid, createHold, releaseHold, attachCheckout, markPaid, expireStaleHolds, savePrep, setStatus, deliver, cancel, undo, publicView, adminList, byId, byToken, recall, remember, UNDO_MS };

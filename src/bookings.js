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
const { HttpError } = require('./http');

const UNDO_MS = 10000; // how long an emailing action waits, so Undo can take it back

const byId = (id) => db.get('SELECT * FROM bookings WHERE id = ?', [id]);
const byToken = (token) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? db.get('SELECT * FROM bookings WHERE token = ?', [token]) : undefined);
const isUniqueClash = (e) => /UNIQUE constraint failed: bookings/.test(String(e && e.message));

function expireStaleHolds(now = new Date()) {
  return db.run("UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'hold' AND hold_expires_at < ?", [now.toISOString(), now.toISOString()]).changes;
}

/** Holds a time for a client while they pay. Throws 409 if the time can't be had any more. */
function createHold({ pkg, slotKey, name, email, phone, notes }, now = new Date()) {
  expireStaleHolds(now);
  const slot = availability.findSlot(pkg, slotKey, now);
  if (!slot) throw new HttpError(409, 'That time was just taken. Pick another one.', { code: 'slot_taken' });
  const p = availability.parseSlotKey(slotKey);
  const iso = now.toISOString();
  try {
    const r = db.run(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email,
        client_phone, notes, price_cents, deposit_cents, hold_expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'hold', ?,?,?,?,?,?,?,?,?)`,
      [crypto.randomBytes(18).toString('base64url'), pkg.id, slotKey, p.date, p.period, slot.start, slot.end, name, email, phone, notes,
        pkg.price_cents, pkg.deposit_cents, new Date(now.getTime() + config.holdMinutes * 60000).toISOString(), iso, iso]);
    return byId(r.lastInsertRowid);
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
function markPaid(token, sessionId, now = new Date()) {
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
    mail.queue('confirmation', fresh);
    mail.queue('admin_new', fresh);
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

/** Delivered: saves the gallery link and queues the gallery email (it waits a few seconds, for Undo). */
function deliver(id, galleryUrl) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (!['shot', 'editing', 'prepped', 'booked'].includes(b.status)) throw new HttpError(400, `A ${b.status} booking can’t be delivered.`);
  let url;
  try { url = new URL(String(galleryUrl || '').trim()); } catch (e) { url = null; }
  if (!url || url.protocol !== 'https:') throw new HttpError(400, 'Paste the gallery’s full link (starting with https://).');
  const iso = db.nowIso();
  return db.tx(() => {
    db.run("UPDATE bookings SET status = 'delivered', gallery_url = ?, delivered_at = ?, updated_at = ? WHERE id = ?", [url.href, iso, iso, id]);
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

/** Undo for deliver and cancel: only while their email hasn't left. */
function undo(id, action, previous) {
  const b = byId(id);
  if (!b) throw new HttpError(404, 'No such booking.');
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
  };
}

function adminList() {
  return db.all(`SELECT b.*, p.name AS package_name FROM bookings b JOIN packages p ON p.id = b.package_id
    WHERE b.status NOT IN ('expired', 'hold') AND (b.status != 'cancelled' OR b.cancelled_at > ?)
    ORDER BY b.start_at`, [new Date(Date.now() - 30 * 86400000).toISOString()])
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

module.exports = { createHold, releaseHold, attachCheckout, markPaid, expireStaleHolds, savePrep, setStatus, deliver, cancel, undo, publicView, adminList, byId, byToken, recall, remember, UNDO_MS };

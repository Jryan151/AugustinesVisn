'use strict';
/* =====================================================================
   requests.js — "None of these work? Request another time."

   Sessions are offered at sunrise and sunset. A client who can't make either sends a request instead: a date, a time
   and a note. Nothing is held and nothing is paid. The photographer gets an email and sees it at the top of the
   Bookings board, where he can:
     - Book it (at their time, or one he's changed it to): a normal in-person booking, and the client gets the usual
       confirmation. He approved it himself, so no email code is needed.
     - Decline it: the client gets a short note pointing them to the open times.
   Both email the client after a short wait, so Undo can take either back (until the email has gone).
   A booked custom time can't overlap another live booking, and golden-hour times that overlap it stop being offered
   (availability.js), so nothing is ever double-booked. One email can send at most 3 requests a day.
   ===================================================================== */
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const config = require('./config');
const availability = require('./availability');
const { HttpError } = require('./http');

const MAX_PER_DAY = 3;
const UNDO_MS = 10000; // the same short wait as the photographer's other emailing moves (bookings.js)
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

/** The moment a local date and time ('YYYY-MM-DD', 'HH:MM') happens in the business's time zone. */
function localToUtc(ymd, hhmm, tz = config.timezone) {
  const [y, m, d] = ymd.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // once more, for a day the clocks change
  return new Date(t);
}
const when = (ymd, hhmm) => localToUtc(ymd, hhmm).toLocaleString('en-US', { timeZone: config.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A client's request. Returns { ok: true }. */
function create(pkg, { date, time, note, name, email, phone }, now = new Date()) {
  if (!availability.isYmd(date) || !isTime(time)) throw new HttpError(400, 'Pick a date and a time.', { field: 'req-date' });
  const at = localToUtc(date, time);
  if (at.getTime() < now.getTime() + 3600000) throw new HttpError(400, 'Pick a time later than today’s next hour.', { field: 'req-date' });
  if (at.getTime() > now.getTime() + 365 * 86400000) throw new HttpError(400, 'Pick a date within the next year.', { field: 'req-date' });
  const since = new Date(now.getTime() - 86400000).toISOString();
  if (db.get('SELECT COUNT(*) n FROM time_requests WHERE client_email = ? AND created_at > ?', [email, since]).n >= MAX_PER_DAY) {
    throw new HttpError(429, 'You’ve sent a few requests today already. The photographer will be in touch.');
  }
  const iso = now.toISOString();
  db.run('INSERT INTO time_requests (package_id, local_date, local_time, note, client_name, client_email, client_phone, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [pkg.id, date, time, note || '', name, email, phone || '', iso, iso]);
  mail.queueNote({
    kind: 'admin_time_request', to: config.adminEmail,
    subject: `Time request: ${name}, ${pkg.name}, ${when(date, time)}`,
    body: `${name} (${email}${phone ? ', ' + phone : ''}) would like ${pkg.name} on ${when(date, time)}, outside your sunrise and sunset times.${note ? `\n\nTheir note: ${note}` : ''}\n\nBook it (or change the time first) or decline it on your Bookings board:\n${config.baseUrl}/admin`,
  });
  return { ok: true };
}

/** Requests still waiting for an answer, soonest first. */
const pending = () => db.all(`SELECT r.*, p.name AS package_name, p.minutes FROM time_requests r JOIN packages p ON p.id = r.package_id
  WHERE r.status = 'pending' ORDER BY r.local_date, r.local_time`).map((r) => Object.assign(r, { when: when(r.local_date, r.local_time) }));

/** The photographer books it, at `time` (or the time asked for). A normal in-person booking; the client is emailed. */
function approve(id, time) {
  const r = db.get("SELECT * FROM time_requests WHERE id = ? AND status = 'pending'", [id]);
  if (!r) throw new HttpError(404, 'That request was already answered.');
  const hhmm = time ? String(time) : r.local_time;
  if (!isTime(hhmm)) throw new HttpError(400, 'Pick a time like 14:30.');
  const pkg = db.get('SELECT * FROM packages WHERE id = ?', [r.package_id]);
  const start = localToUtc(r.local_date, hhmm); const end = new Date(start.getTime() + pkg.minutes * 60000);
  if (start.getTime() < Date.now()) throw new HttpError(400, 'That time has already passed. Change it, or decline.');
  // Never on top of another booking (the golden-hour ones included).
  const clash = availability.liveBookingsBetween(r.local_date, r.local_date).find((b) => Date.parse(b.start_at) < end.getTime() && start.getTime() < Date.parse(b.end_at));
  if (clash) throw new HttpError(409, 'That overlaps another booking. Change the time first.');
  const iso = new Date().toISOString();
  return db.tx(() => {
    let b;
    try {
      const out = db.run(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email,
          client_phone, notes, price_cents, deposit_cents, pay_method, created_at, updated_at) VALUES (?,?,?,?,'custom',?,?, 'booked', ?,?,?,?,?, 0, 'in_person', ?,?)`,
        [crypto.randomBytes(18).toString('base64url'), pkg.id, `${r.local_date}:custom-${hhmm.replace(':', '')}`, r.local_date, start.toISOString(), end.toISOString(),
          r.client_name, r.client_email, r.client_phone, r.note, pkg.price_cents, iso, iso]);
      b = db.get('SELECT * FROM bookings WHERE id = ?', [out.lastInsertRowid]);
    } catch (e) {
      if (/UNIQUE constraint failed: bookings/.test(e.message)) throw new HttpError(409, 'That time is already booked. Change the time first.');
      throw e;
    }
    db.run("UPDATE time_requests SET status = 'booked', booking_id = ?, local_time = ?, updated_at = ? WHERE id = ?", [b.id, hhmm, iso, id]);
    mail.queue('confirmation', b, { delayMs: UNDO_MS });
    return b;
  });
}

/** The photographer can't do it: the client gets a short, kind note. */
function decline(id) {
  const r = db.get("SELECT * FROM time_requests WHERE id = ? AND status = 'pending'", [id]);
  if (!r) throw new HttpError(404, 'That request was already answered.');
  const pkg = db.get('SELECT name FROM packages WHERE id = ?', [r.package_id]);
  const noteId = mail.queueNote({
    kind: 'time_request_declined', to: r.client_email, delayMs: UNDO_MS,
    subject: `About your ${pkg.name} request`,
    body: `Hi ${r.client_name.split(/\s+/)[0] || 'there'},\n\nThanks for asking. I can’t do ${when(r.local_date, r.local_time)}, sorry. My sunrise and sunset times are open here, if one of those works:\n${config.baseUrl}/book\n\n${config.businessName}`,
  });
  db.run("UPDATE time_requests SET status = 'declined', note_id = ?, updated_at = ? WHERE id = ?", [noteId, new Date().toISOString(), id]);
  return { ok: true };
}

/** Undo for Book it and Decline: back to waiting, only while the client's email hasn't left. */
function undo(id) {
  const r = db.get('SELECT * FROM time_requests WHERE id = ?', [id]);
  if (!r || r.status === 'pending') throw new HttpError(400, 'Nothing to undo.');
  return db.tx(() => {
    if (r.status === 'booked') {
      if (!mail.unqueue('confirmation', r.booking_id)) throw new HttpError(409, 'Too late to undo: the client has already been told.');
      db.run('DELETE FROM outbox WHERE booking_id = ?', [r.booking_id]);
      db.run('DELETE FROM bookings WHERE id = ?', [r.booking_id]);
    } else if (!mail.unqueueNote(r.note_id)) throw new HttpError(409, 'Too late to undo: the client has already been told.');
    db.run("UPDATE time_requests SET status = 'pending', booking_id = NULL, note_id = NULL, updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    return { ok: true };
  });
}

module.exports = { create, pending, approve, decline, undo, localToUtc };

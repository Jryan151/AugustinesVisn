'use strict';
/* =====================================================================
   jobs.js — the work that happens on its own, once a minute.

   - Unpaid holds past their window are released, so the time shows as free again.
   - Reminders are queued: 3 days before and 1 day before the session.
   - The review request is queued 7 days after the gallery goes out.
   - The outbox sends what's due.
   - Old idempotency answers (over a day) are cleared, and photos removed over a day ago are really deleted.
   - Once a day, a full copy of the database goes to data/backups/ (14 kept). Copy that folder off the server too.
   Each step is safe to run again: the outbox's unique index means a reminder is never queued twice.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const bookings = require('./bookings');
const galleries = require('./galleries');

const DAY = 86400000;

function queueDue(now = new Date()) {
  const iso = now.toISOString();
  const upcoming = (withinMs) => db.all("SELECT * FROM bookings WHERE status IN ('booked', 'prepped') AND start_at > ? AND start_at <= ?",
    [iso, new Date(now.getTime() + withinMs).toISOString()]);
  // The 3-day one only while it's still more than a day away, so a late booking doesn't get both at once.
  for (const b of upcoming(3 * DAY)) if (new Date(b.start_at) - now > DAY) mail.queue('reminder3', b);
  for (const b of upcoming(DAY)) mail.queue('reminder1', b);
  for (const b of db.all("SELECT * FROM bookings WHERE status = 'delivered' AND delivered_at <= ?", [new Date(now.getTime() - 7 * DAY).toISOString()])) mail.queue('review', b);
}

/** A consistent copy of the whole database, made while it runs (SQLite's VACUUM INTO). One per day, 14 kept. */
function backup(now = new Date(), dir = config.backupDir, keep = 14) {
  if (config.dbFile === ':memory:') return null;
  const file = path.join(dir, `booking-${now.toISOString().slice(0, 10)}.sqlite`);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  db.run('VACUUM INTO ?', [file]);
  const old = fs.readdirSync(dir).filter((f) => /^booking-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return file;
}

async function tick(now = new Date()) {
  bookings.expireStaleHolds(now);
  queueDue(now);
  await mail.processOutbox(now);
  db.run('DELETE FROM idempotency WHERE created_at < ?', [new Date(now.getTime() - DAY).toISOString()]);
  galleries.purgeDeleted(now);
  require('./inperson').purge(now);
  try { backup(now); } catch (e) { console.error('backup failed:', e.message); }
}

let timer = null;
function start(everyMs = 60000) {
  const run = () => tick().catch((e) => console.error('jobs:', e.message));
  run();
  // Emails waiting on Undo go out 10 s later, so check the outbox more often than the rest.
  timer = setInterval(run, Math.min(everyMs, 15000));
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { tick, queueDue, start, stop, backup };

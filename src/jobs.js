'use strict';
/* =====================================================================
   jobs.js — the work that happens on its own, once a minute.

   - Unpaid holds past their window are released, so the time shows as free again.
   - Reminders are queued: 3 days before and 1 day before the session.
   - The review request is queued 7 days after the gallery goes out.
   - The outbox sends what's due.
   - Old idempotency answers (over a day) are cleared.
   Each step is safe to run again: the outbox's unique index means a reminder is never queued twice.
   ===================================================================== */
const db = require('./db');
const mail = require('./mail');
const bookings = require('./bookings');

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

async function tick(now = new Date()) {
  bookings.expireStaleHolds(now);
  queueDue(now);
  await mail.processOutbox(now);
  db.run('DELETE FROM idempotency WHERE created_at < ?', [new Date(now.getTime() - DAY).toISOString()]);
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

module.exports = { tick, queueDue, start, stop };

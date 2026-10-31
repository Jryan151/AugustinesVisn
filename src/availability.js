'use strict';
/* =====================================================================
   availability.js — which session times a client can pick.

   Every session is at golden hour, the light this kind of work is sold on:
     morning  starts a little before sunrise (morningLeadMinutes)
     evening  ends a little after sunset (eveningTailMinutes), so its start depends on the package's length
   So a day has at most two times, far apart. That's the travel buffer, built in: nobody can book back-to-back shoots
   across town. On top of that, the photographer's rules (Admin › Setup › Availability):
     - which weekdays offer morning and which offer evening
     - blocked dates (holidays, other work)
     - minimum notice and how far ahead people can book
     - a weekly cap (Mon–Sun) set by how many shoots they can edit in time to keep the turnaround promise
   A time is a slot key, 'YYYY-MM-DD:evening'. The database allows one live booking per key.
   A custom time (a client's request the photographer booked, requests.js) is 'YYYY-MM-DD:custom-1430'. A golden-hour
   time that overlaps a booked custom time isn't offered, so nothing is ever double-booked.

   computeDays() is pure (everything comes in as arguments), so the rules are tested without a database.
   ===================================================================== */
const db = require('./db');
const config = require('./config');
const { sunTimes } = require('./sun');

const PERIODS = ['morning', 'evening'];
const FIVE_MIN = 5 * 60 * 1000;

const dateFmt = {};
/** The calendar date ('YYYY-MM-DD') of a moment, in the business's time zone. */
function localDate(d, tz = config.timezone) {
  if (!dateFmt[tz]) dateFmt[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dateFmt[tz].format(d);
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const weekday = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
/** The Monday that starts this date's week: the weekly cap counts Monday to Sunday. */
const weekKey = (ymd) => addDays(ymd, -((weekday(ymd) + 6) % 7));

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
function parseSlotKey(key) {
  const m = /^(\d{4}-\d{2}-\d{2}):(morning|evening)$/.exec(String(key || ''));
  return m && isYmd(m[1]) ? { date: m[1], period: m[2] } : null;
}

/** The start and end of one period on one date for a session `minutes` long, or null if the sun doesn't allow it. */
function periodTimes(ymd, period, minutes, rules, lat, lng) {
  const sun = sunTimes(ymd, lat, lng);
  if (!sun) return null;
  let start;
  if (period === 'morning') start = sun.sunrise.getTime() - rules.morningLeadMinutes * 60000;
  else start = sun.sunset.getTime() + rules.eveningTailMinutes * 60000 - minutes * 60000;
  start = Math.floor(start / FIVE_MIN) * FIVE_MIN; // clean times: 5:20, not 5:23
  return { start: new Date(start), end: new Date(start + minutes * 60000) };
}

/**
 * The bookable times for `days` days starting at `fromYmd`.
 *   minutes     the package's length
 *   rules       the availability setting
 *   now         a Date
 *   taken       Set of slot keys already held or booked
 *   weekCounts  Map of week key → live bookings that week
 * Returns [{ date, slots: [{ key, period, start, end }] }], one entry per day (slots may be empty).
 */
function computeDays({ fromYmd, days, minutes, rules, now, lat = config.latitude, lng = config.longitude, taken = new Set(), weekCounts = new Map(), busy = [] }) {
  const out = [];
  const earliest = now.getTime() + rules.minNoticeHours * 3600000;
  const lastYmd = addDays(localDate(now), rules.maxDaysAhead);
  const blocked = new Set(rules.blockedDates || []);
  for (let i = 0; i < days; i++) {
    const date = addDays(fromYmd, i);
    const day = { date, slots: [] };
    out.push(day);
    if (date > lastYmd || blocked.has(date)) continue;
    if ((weekCounts.get(weekKey(date)) || 0) >= rules.weeklyCap) continue;
    const wd = weekday(date);
    for (const period of PERIODS) {
      if (!(rules[period] || []).includes(wd)) continue;
      const key = `${date}:${period}`;
      if (taken.has(key)) continue;
      const t = periodTimes(date, period, minutes, rules, lat, lng);
      if (!t || t.start.getTime() < earliest) continue;
      if (busy.some((b) => b.start < t.end.getTime() && t.start.getTime() < b.end)) continue; // overlaps a custom time
      day.slots.push({ key, period, start: t.start.toISOString(), end: t.end.toISOString() });
    }
  }
  return out;
}

/* ---------- with the database ---------- */

/** Bookings that hold a time right now: everything live, except holds whose payment window has passed. */
function liveBookingsBetween(fromYmd, toYmd, now = new Date()) {
  const marks = db.ACTIVE.map(() => '?').join(',');
  return db.all(
    `SELECT slot_key, local_date, start_at, end_at FROM bookings WHERE status IN (${marks}) AND local_date BETWEEN ? AND ?
       AND NOT (status = 'hold' AND hold_expires_at < ?)`,
    [...db.ACTIVE, weekKey(fromYmd), addDays(weekKey(toYmd), 6), now.toISOString()]);
}

function forPackage(pkg, fromYmd, days, now = new Date()) {
  const toYmd = addDays(fromYmd, days - 1);
  const rows = liveBookingsBetween(fromYmd, toYmd, now);
  const taken = new Set(rows.map((r) => r.slot_key));
  const weekCounts = new Map();
  for (const r of rows) { const w = weekKey(r.local_date); weekCounts.set(w, (weekCounts.get(w) || 0) + 1); }
  const busy = rows.filter((r) => r.slot_key.includes(':custom-')).map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));
  return computeDays({ fromYmd, days, minutes: pkg.minutes, rules: db.setting('availability'), now, taken, weekCounts, busy });
}

/** The slot if it can be booked right now for this package, else null. */
function findSlot(pkg, slotKey, now = new Date()) {
  const s = parseSlotKey(slotKey);
  if (!s) return null;
  const [day] = forPackage(pkg, s.date, 1, now);
  return day.slots.find((x) => x.key === slotKey) || null;
}

module.exports = { computeDays, forPackage, findSlot, liveBookingsBetween, periodTimes, parseSlotKey, localDate, addDays, weekKey, weekday, isYmd, PERIODS };

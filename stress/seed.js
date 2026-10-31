'use strict';
/* =====================================================================
   stress/seed.js — fills a throwaway database with a year of made-up history.

   node stress/seed.js <db file> [scale]
     scale 1  = a realistic year at the photographer's cap (about 4 shoots a week ≈ 200 sessions)
     scale 10 = ten times that (≈ 2,000), to see where lists and jobs stop scaling

   EVERY NUMBER HERE IS AN ASSUMPTION, not a measurement. Patterns found later in this data only show that the
   queries work and what they would reveal; they say nothing about real clients.
   ===================================================================== */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

// ---- assumptions (change these to try other shapes of business) ----
const A = {
  sessionsPerWeek: 4,          // the weekly cap
  daysBack: 365, daysAhead: 60,
  weekdayWeight: [3, 1, 1, 1, 1.5, 2, 3.5],   // Sun..Sat: weekends fill first
  morningShare: 0.2,
  packageMix: { portrait: 0.45, couples: 0.35, automotive: 0.2 },
  zelleShare: 0.4,
  abandonedHoldsPerBooking: 0.35, // holds that never paid (expired) for every real booking
  cancelShare: 0.05, needsRefundShare: 0.01,
  prepShare: 0.75,
  balancePaidShare: 0.7, balanceBy: { marked: 0.5, online: 0.3, zelle: 0.2 },
  turnaroundJitter: [0.5, 1.6],   // delivered between 0.5x and 1.6x the promised turnaround
  repeatShare: 0.25,              // chance a booking comes from someone who has booked before
};

const file = process.argv[2]; const scale = Number(process.argv[3] || 1);
if (!file) { console.error('node stress/seed.js <db file> [scale]'); process.exit(1); }
const d = new DatabaseSync(file);
const pkgs = Object.fromEntries(d.prepare('SELECT * FROM packages').all().map((p) => [p.slug, p]));
const DAY = 86400000;
const rnd = (a, b) => a + Math.random() * (b - a);
const choose = (weights) => { let r = Math.random() * Object.values(weights).reduce((s, w) => s + w, 0); for (const [k, w] of Object.entries(weights)) { if ((r -= w) <= 0) return k; } return Object.keys(weights)[0]; };
const iso = (t) => new Date(t).toISOString();
const ymd = (t) => new Date(t - 7 * 3600000).toISOString().slice(0, 10); // Phoenix is UTC-7 all year
const tok = () => crypto.randomBytes(18).toString('base64url');

const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Sofia', 'Mateo', 'Isla', 'Kai', 'Luna', 'Ezra', 'Nora', 'Leo', 'Zoe', 'Eli', 'Aria', 'Jude'];
const LAST = ['Garcia', 'Nguyen', 'Smith', 'Lopez', 'Kim', 'Patel', 'Reyes', 'Brown', 'Diaz', 'Young', 'Hall', 'Cruz'];
const clients = [];
const newClient = () => { const c = { name: `${FIRST[clients.length % FIRST.length]} ${LAST[(clients.length * 7) % LAST.length]}`, email: `seed${clients.length}@example.test`, phone: '555-01' + String(clients.length % 100).padStart(2, '0') }; clients.push(c); return c; };

const now = Date.now();
const ins = d.prepare(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email, client_phone, notes,
  price_cents, deposit_cents, hold_expires_at, paid_at, prep_json, prepped_at, gallery_url, delivered_at, cancelled_at, created_at, updated_at,
  pay_method, ref_code, zelle_sent_at, balance_paid_at, balance_paid_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const photo = d.prepare('INSERT INTO photos (booking_id, original, web, thumb, file_name, bytes, width, height, created_at, wm, wm_thumb) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const mail = d.prepare("INSERT OR IGNORE INTO outbox (booking_id, kind, to_addr, subject, body, status, send_after, created_at, sent_at) VALUES (?,?,?,?,?,'sent',?,?,?)");

const used = new Set(d.prepare("SELECT slot_key FROM bookings").all().map((r) => r.slot_key));
let made = 0; let abandoned = 0;
d.exec('BEGIN');
const weeks = Math.ceil((A.daysBack + A.daysAhead) / 7);
for (let w = 0; w < weeks; w++) {
  for (let k = 0; k < A.sessionsPerWeek * scale; k++) {
    // a shoot date in this week, weekend-weighted
    const wd = Number(choose(Object.fromEntries(A.weekdayWeight.map((x, i) => [i, x]))));
    const weekStart = now - A.daysBack * DAY + w * 7 * DAY;
    const dayT = weekStart + ((wd - new Date(weekStart).getUTCDay() + 7) % 7) * DAY;
    if (dayT > now + A.daysAhead * DAY) continue;
    const period = Math.random() < A.morningShare ? 'morning' : 'evening';
    let slot = `${ymd(dayT)}:${period}`;
    // at scale > 1 there are more bookings than real slots: suffix keeps the unique index happy (stress data only)
    for (let x = 2; used.has(slot); x++) slot = `${ymd(dayT)}:${period}#${x}`;
    used.add(slot);
    const p = pkgs[choose(A.packageMix)];
    const start = dayT - (dayT % DAY) + (period === 'morning' ? 13 : 1) * 3600000 + (period === 'evening' ? DAY : 0);
    const end = start + p.minutes * 60000;
    const lead = Math.exp(rnd(Math.log(2.5), Math.log(45))) * DAY; // 2.5 to 45 days ahead, most in the first fortnight
    const created = Math.min(start - lead, now - 3600000);
    const c = Math.random() < A.repeatShare && clients.length ? clients[Math.floor(Math.random() * clients.length)] : newClient();
    const method = Math.random() < A.zelleShare ? 'zelle' : 'card';
    const past = end < now;
    let status;
    const roll = Math.random();
    if (roll < A.cancelShare) status = 'cancelled';
    else if (roll < A.cancelShare + A.needsRefundShare) status = 'needs_refund';
    else if (!past) status = Math.random() < A.prepShare ? 'prepped' : 'booked';
    else if (now - end < 3 * DAY) status = 'shot';
    else {
      const deliverAt = end + p.turnaround_days * rnd(...A.turnaroundJitter) * DAY;
      status = deliverAt < now ? 'delivered' : 'editing';
    }
    const delivered = status === 'delivered' ? Math.min(now - 3600000, end + p.turnaround_days * rnd(...A.turnaroundJitter) * DAY) : null;
    const paidBalance = delivered && Math.random() < A.balancePaidShare;
    const balanceAt = paidBalance ? Math.min(now - 60000, delivered + rnd(0, 12) * DAY) : null;
    const preped = !['cancelled', 'needs_refund'].includes(status) && Math.random() < A.prepShare;
    const paidAt = created + (method === 'zelle' ? rnd(0.5, 20) * 3600000 : rnd(1, 15) * 60000);
    const r = ins.run(tok(), p.id, slot, ymd(dayT), period, iso(start), iso(end), status, c.name, c.email, c.phone, '',
      p.price_cents, p.deposit_cents, null, iso(paidAt), preped ? JSON.stringify({ location: 'Papago Park', look: 'Warm', who: '2' }) : null,
      preped ? iso(paidAt + rnd(1, 72) * 3600000) : null, delivered ? (Math.random() < 0.7 ? 'https://book.example.test/gallery/seed' : 'https://drive.example.test/folder') : null, delivered ? iso(delivered) : null,
      status === 'cancelled' ? iso(created + rnd(1, 10) * DAY) : null, iso(created), iso(balanceAt || delivered || paidAt),
      method, method === 'zelle' ? 'AV' + crypto.randomBytes(3).toString('hex').toUpperCase() : null, method === 'zelle' ? iso(created + 1800000) : null,
      balanceAt ? iso(balanceAt) : null, balanceAt ? choose(A.balanceBy) : null);
    const id = Number(r.lastInsertRowid); made++;
    if (status === 'delivered') {
      for (let i = 0; i < p.photos; i++) photo.run(id, `s${id}-${i}.jpg`, `s${id}-${i}-web.jpg`, `s${id}-${i}-thumb.jpg`, `IMG_${1000 + i}.jpg`, 9000000, 6000, 4000, iso(delivered - DAY), `s${id}-${i}-wm.jpg`, `s${id}-${i}-wmt.jpg`);
    }
    for (const kind of ['confirmation', 'admin_new', ...(past ? ['reminder3', 'reminder1'] : []), ...(delivered ? ['gallery'] : []), ...(delivered && delivered < now - 7 * DAY ? ['review'] : []), ...(balanceAt ? ['unlocked'] : [])]) {
      mail.run(id, kind, c.email, kind, '(seed)', iso(paidAt), iso(paidAt), iso(paidAt));
    }
    // holds that never paid, around this time
    for (let h = 0; h < 3; h++) {
      if (Math.random() > A.abandonedHoldsPerBooking / 3) continue;
      const hm = Math.random() < A.zelleShare ? 'zelle' : 'card';
      const hc = newClient();
      ins.run(tok(), p.id, slot + '~h' + h, ymd(dayT), period, iso(start), iso(end), 'expired', hc.name, hc.email, '', '', p.price_cents, p.deposit_cents,
        iso(created + (hm === 'zelle' ? 24 : 0.5) * 3600000), null, null, null, null, null, null, iso(created - rnd(0, 5) * DAY), iso(created), hm, null, null, null, null);
      abandoned++;
    }
  }
}
d.exec('COMMIT');
d.close();
console.log(JSON.stringify({ file, scale, bookings: made, abandonedHolds: abandoned, clients: clients.length }));

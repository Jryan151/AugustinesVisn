'use strict';
/* =====================================================================
   demo.js — the sample data behind the demo (Admin's Demo switch; context.js), so every feature can be seen working.

   reset() wipes the demo's own database and photo folders, then builds:
     - the three packages, with card photos and example shots, and photos behind every page
     - an open offer (a package made for one client)
     - a booking at every stage: waiting on a Zelle deposit, booked (card), booked in person, prepped, shot, editing,
       delivered and locked (balance due), delivered and paid, needs refund, cancelled
     - a returning client with private notes, and the emails those bookings would have sent
   Every date is worked out from today, so the demo always looks current. The photos are made with ffmpeg (plain warm
   gradients, no one's real work) and go through the same upload code as real ones; without ffmpeg there are no photos.
   It runs only inside a demo request, and refuses otherwise: the real site's data is never touched.
   ===================================================================== */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const availability = require('./availability');
const context = require('./context');

const DAY = 86400000;
const tok = () => crypto.randomBytes(18).toString('base64url');

/** A photo made on the spot: a soft gradient in sunset colours. Returns the file, or null without ffmpeg. */
function makePhoto(file, seed, w = 1800, h = 1200) {
  return new Promise((resolve) => execFile(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `gradients=s=${w}x${h}:seed=${seed}:c0=0x2a1a12:c1=0xe8a35a:c2=0x6b3a2a:c3=0x1b1f2e:nb_colors=4`, '-frames:v', '1', '-q:v', '4', file],
  { timeout: 60000 }, (e) => resolve(e ? null : file)));
}
/** A stored file handed to the real upload code, as if it came from the browser. */
function asUpload(file, name = path.basename(file)) {
  const s = fs.createReadStream(file);
  s.headers = { 'content-length': String(fs.statSync(file).size), 'x-file-name': name, 'content-type': 'image/jpeg' };
  return s;
}

/** A real slot key and its sun-set times, `daysFromNow` days away (negative = in the past). */
function slotAt(daysFromNow, period = 'evening', minutes = 60) {
  const date = availability.addDays(availability.localDate(new Date()), daysFromNow);
  const t = availability.periodTimes(date, period, minutes, db.setting('availability'), config.latitude, config.longitude);
  return { key: `${date}:${period}`, date, period, start: t.start.toISOString(), end: t.end.toISOString() };
}

async function reset() {
  // Twice-checked: inside the demo, and pointed at the demo's own folders. The real site's files are never touched.
  if (!context.isDemo() || !config.galleryDir.startsWith(config.demoDir) || !config.mediaDir.startsWith(config.demoDir)) throw new Error('demo.reset() runs only in the demo.');
  // Start clean: the demo's own data only (config points every folder at the demo's directory).
  for (const t of ['photos', 'portfolio', 'outbox', 'email_checks', 'idempotency', 'clients', 'bookings']) db.run(`DELETE FROM ${t}`);
  // The packages go back to the starting three (a visitor may have edited or added some).
  db.run('DELETE FROM packages');
  for (const p of db.SEED_PACKAGES) {
    db.run('INSERT INTO packages (slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, sort) VALUES (?,?,?,?,?,?,?,?,?)',
      [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, p.sort]);
  }
  db.run("DELETE FROM settings WHERE key IN ('siteBackground', 'payments', 'availability')");
  for (const dir of [config.mediaDir, config.galleryDir]) fs.rmSync(dir, { recursive: true, force: true });

  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { blockedDates: [availability.addDays(availability.localDate(new Date()), 12)] }));
  db.saveSetting('payments', { zelle: { enabled: true, recipient: 'augustine@demo.example', name: 'Augustine V.', holdHours: 24, qr: null }, inPerson: { enabled: true } });

  const pkgs = Object.fromEntries(db.all('SELECT * FROM packages WHERE offer = 0').map((p) => [p.slug, p]));
  const offer = db.run(`INSERT INTO packages (slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, sort, active, offer)
    VALUES (?,?,?,?,?,?,?,?,?,1,1)`, ['offer-' + crypto.randomBytes(9).toString('hex'), 'Golden hour with Maya',
    'Your Supra at Papago Park as the sun goes down: rolling shots on the loop, then a few portraits with the car.', 75, 30, 10, 30000, 9000, 99]);
  const offerPkg = db.get('SELECT * FROM packages WHERE id = ?', [offer.lastInsertRowid]);

  // ---- bookings, one at every stage ----
  const insert = (o) => {
    const p = o.pkg; const s = slotAt(o.days, o.period, p.minutes);
    const created = now - (o.bookedDaysAgo || 6) * DAY;
    const r = db.run(`INSERT INTO bookings (token, package_id, slot_key, local_date, period, start_at, end_at, status, client_name, client_email,
      client_phone, notes, price_cents, deposit_cents, hold_expires_at, paid_at, prep_json, prepped_at, gallery_url, delivered_at, cancelled_at,
      created_at, updated_at, pay_method, ref_code, zelle_sent_at, balance_paid_at, balance_paid_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tok(), p.id, s.key, s.date, s.period, s.start, s.end, o.status, o.name, o.email, o.phone || '', o.notes || '',
      p.price_cents, o.method === 'in_person' ? 0 : p.deposit_cents, o.holdUntil ? iso(o.holdUntil) : null,
      o.paid === false ? null : iso(created + 15 * 60000), o.prep ? JSON.stringify(o.prep) : null, o.prep ? iso(created + DAY) : null,
      null, null, o.status === 'cancelled' ? iso(now - 2 * DAY) : null, iso(created), iso(now - DAY),
      o.method || 'card', o.method === 'zelle' ? 'AV' + crypto.randomBytes(2).toString('hex').toUpperCase() : null,
      o.zelleSent ? iso(now - 3 * 3600000) : null, o.balancePaid ? iso(now - o.balancePaid * DAY) : null, o.balancePaid ? 'online' : null]);
    return db.get('SELECT * FROM bookings WHERE id = ?', [r.lastInsertRowid]);
  };
  const plan = { location: 'Papago Park, by the hole-in-the-rock', look: 'Warm and candid, a bit cinematic', who: 'Me and my partner', references: 'instagram.com/… (a few saved posts)', other: '' };
  const made = {
    zelle: insert({ pkg: pkgs.couples, days: 6, status: 'hold', method: 'zelle', paid: false, zelleSent: true, holdUntil: now + 40 * 3600000, name: 'Diego Morales', email: 'diego@demo.example', phone: '602-555-0141', bookedDaysAgo: 0 }),
    booked: insert({ pkg: pkgs.portrait, days: 4, status: 'booked', name: 'Priya Shah', email: 'priya@demo.example', phone: '480-555-0117', notes: 'Senior photos, school colours are maroon and gold.' }),
    inPerson: insert({ pkg: pkgs.automotive, days: 9, status: 'booked', method: 'in_person', paid: false, name: 'Marcus Lee', email: 'marcus@demo.example', phone: '623-555-0199', notes: 'Black LS430, freshly detailed.' }),
    offer: insert({ pkg: offerPkg, days: 11, status: 'prepped', prep: { location: 'Papago Park loop', look: 'Rolling shots, then moody portraits', who: 'Maya and her Supra' }, name: 'Maya Reyes', email: 'maya@demo.example', phone: '602-555-0164' }),
    prepped: insert({ pkg: pkgs.couples, days: 2, status: 'prepped', prep: plan, name: 'Ava & Leo Garcia', email: 'ava@demo.example', phone: '480-555-0102' }),
    shot: insert({ pkg: pkgs.portrait, days: -1, status: 'shot', prep: plan, name: 'Noah Kim', email: 'noah@demo.example', bookedDaysAgo: 14 }),
    editing: insert({ pkg: pkgs.automotive, days: -5, status: 'editing', name: 'Sofia Nguyen', email: 'sofia@demo.example', bookedDaysAgo: 20 }),
    locked: insert({ pkg: pkgs.couples, days: -9, status: 'delivered', prep: plan, name: 'Isla Brown', email: 'isla@demo.example', bookedDaysAgo: 30 }),
    paid: insert({ pkg: pkgs.portrait, days: -12, status: 'delivered', balancePaid: 2, name: 'Mateo Cruz', email: 'mateo@demo.example', bookedDaysAgo: 35 }),
    refund: insert({ pkg: pkgs.portrait, days: 4, period: 'morning', status: 'needs_refund', name: 'Kai Young', email: 'kai@demo.example', bookedDaysAgo: 1 }),
    cancelled: insert({ pkg: pkgs.couples, days: 8, status: 'cancelled', name: 'Zoe Hall', email: 'zoe@demo.example', bookedDaysAgo: 10 }),
    // A returning client: a delivered session in the spring, and another one coming up.
    before: insert({ pkg: pkgs.portrait, days: -150, status: 'delivered', balancePaid: 140, name: 'Ezra Patel', email: 'ezra@demo.example', bookedDaysAgo: 170 }),
    again: insert({ pkg: pkgs.automotive, days: 16, status: 'booked', name: 'Ezra Patel', email: 'ezra@demo.example', bookedDaysAgo: 2 }),
  };
  db.run("INSERT INTO clients (email, notes, updated_at) VALUES ('ezra@demo.example', 'Second session. Loved the moody edits last time; brings his dog. Referred Priya.', ?)", [iso(now)]);
  db.run('UPDATE bookings SET ref_code = ? WHERE id = ?', ['AV' + crypto.randomBytes(2).toString('hex').toUpperCase(), made.locked.id]);

  // ---- photos (when ffmpeg is here): backgrounds, card photos, example shots, and two delivered galleries ----
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'av-demo-'));
  try {
    const shots = [];
    for (let i = 0; i < 6; i++) { const f = await makePhoto(path.join(tmp, `demo-${i + 1}.jpg`), i * 7 + 3); if (f) shots.push(f); }
    if (shots.length) {
      const sitemedia = require('./sitemedia');
      const galleries = require('./galleries');
      for (const f of shots.slice(0, 2)) await sitemedia.addBackground(asUpload(f));
      let i = 0;
      for (const p of Object.values(pkgs)) {
        await sitemedia.setPackageImage(p.id, asUpload(shots[i % shots.length]));
        for (let k = 0; k < 3; k++) await sitemedia.addPortfolio(p.id, asUpload(shots[(i + k + 1) % shots.length]));
        i++;
      }
      for (let k = 0; k < 3; k++) await sitemedia.addPortfolio(offerPkg.id, asUpload(shots[(k + 2) % shots.length]));
      for (const b of [made.locked, made.paid, made.before]) {
        for (let k = 0; k < shots.length; k++) await galleries.add(b.id, asUpload(shots[k], `IMG_${2400 + k}.jpg`));
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  for (const b of [made.locked, made.paid, made.before]) {
    db.run('UPDATE bookings SET gallery_url = ?, delivered_at = ? WHERE id = ?', [`${config.baseUrl}/gallery/${b.token}`, iso(new Date(b.end_at).getTime() + 6 * DAY), b.id]);
  }

  // ---- the emails these bookings would have sent (printed, never sent: the demo has no email key) ----
  const mail = require('./mail');
  const sent = (kind, b) => { if (mail.queue(kind, db.get('SELECT * FROM bookings WHERE id = ?', [b.id]))) db.run("UPDATE outbox SET status = 'sent', sent_at = created_at WHERE booking_id = ? AND kind = ?", [b.id, kind]); };
  for (const b of Object.values(made)) {
    if (['hold', 'cancelled'].includes(b.status)) continue;
    sent('confirmation', b); sent('admin_new', b);
  }
  sent('zelle_deposit', made.zelle); sent('admin_zelle_deposit', made.zelle);
  for (const b of [made.locked, made.paid, made.before]) sent('gallery', b);
  for (const b of [made.paid, made.before]) sent('unlocked', b);
  sent('admin_needs_refund', made.refund);
  db.saveSetting('demoResetAt', iso(now));
  return { bookings: Object.keys(made).length, offer: offerPkg.slug };
}

/** The first time the demo is switched on: build the sample data (it stays as it's played with, until Reset). */
async function prepare() {
  if (!context.isDemo()) return null;
  if (db.get('SELECT 1 FROM bookings LIMIT 1')) return null;
  return reset();
}

module.exports = { reset, prepare };

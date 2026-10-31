'use strict';
/* =====================================================================
   db.js — the database: one SQLite file, Node's own driver (node:sqlite), nothing to install.

   The driver is synchronous. That's a feature here: a check and the write after it ("is this time still free?" →
   "hold it") can't be interleaved with another request, so two clients can never book the same time. A unique index
   on the time backs that up at the database level as well.

   Tables:
     packages     what a client can book (length, photos, turnaround, price, deposit)
     bookings     one row per session, from hold to delivered (see STATUSES)
     settings     the photographer's rules as JSON values (availability, terms)
     outbox       every email, queued first and sent by the job loop (one per booking per kind, never twice)
     idempotency  answers already given to a request key, so a retried "pay" never makes a second booking
     photos       a client's finished photos, per booking (files in data/galleries/<booking id>/)
     portfolio    example shots per package, shown on the package's portfolio page
     clients      the photographer's private notes on a client, by email (everything else about a client is
                  worked out from their bookings, so it can never disagree with them)
   ===================================================================== */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// The life of a booking. 'hold' lasts while the client pays; cancelled/expired/needs_refund leave the pipeline.
const PIPELINE = ['booked', 'prepped', 'shot', 'editing', 'delivered'];
const ACTIVE = ['hold'].concat(PIPELINE); // these take up a time and count toward the weekly cap
const STATUSES = ACTIVE.concat(['cancelled', 'expired', 'needs_refund']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL,
  photos INTEGER NOT NULL,
  turnaround_days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  bg_video TEXT NOT NULL DEFAULT '',
  bg_poster TEXT NOT NULL DEFAULT '',
  image_json TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  slot_key TEXT NOT NULL,
  local_date TEXT NOT NULL,
  period TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  hold_expires_at TEXT,
  stripe_session_id TEXT,
  paid_at TEXT,
  prep_json TEXT,
  prepped_at TEXT,
  gallery_url TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live booking per time. Cancelled, expired and refunded rows don't count.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_per_slot ON bookings(slot_key)
  WHERE status NOT IN ('cancelled', 'expired', 'needs_refund');
CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status, start_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER,
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  send_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
-- The same email can't be queued twice for one booking (a second reminder, a second confirmation).
CREATE UNIQUE INDEX IF NOT EXISTS outbox_once ON outbox(booking_id, kind) WHERE booking_id IS NOT NULL AND status != 'cancelled';
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  original TEXT NOT NULL,
  web TEXT NOT NULL,
  thumb TEXT NOT NULL,
  file_name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_booking ON photos(booking_id, id);
-- A package's portfolio: example shots shown on /portfolio/<slug>. Public files in data/media/.
CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  file_json TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portfolio_package ON portfolio(package_id, sort, id);
CREATE TABLE IF NOT EXISTS clients (
  email TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// What a new site starts with. The photographer changes all of it in Admin.
const SEED_PACKAGES = [
  { slug: 'portrait', name: 'Portrait', summary: 'One person, one location. Headshots, seniors, personal brand.', minutes: 45, photos: 20, turnaround_days: 7, price_cents: 22500, deposit_cents: 7500, sort: 1 },
  { slug: 'couples', name: 'Couples & Family', summary: 'Up to 6 people, one location, a relaxed walk-and-shoot.', minutes: 60, photos: 35, turnaround_days: 10, price_cents: 32500, deposit_cents: 10000, sort: 2 },
  { slug: 'automotive', name: 'Automotive', summary: 'One car, rolling and static shots, chosen backdrop at golden hour.', minutes: 75, photos: 30, turnaround_days: 10, price_cents: 35000, deposit_cents: 10000, sort: 3 },
];
const DEFAULT_SETTINGS = {
  availability: {
    // Which golden-hour sessions are offered on each weekday (0 = Sunday … 6 = Saturday).
    morning: [0, 6],
    evening: [0, 1, 2, 3, 4, 5, 6],
    weeklyCap: 4, // shoots per week (Mon–Sun), set by how many the photographer can edit on time
    minNoticeHours: 48,
    maxDaysAhead: 60,
    blockedDates: [], // 'YYYY-MM-DD'
    morningLeadMinutes: 15, // a morning session starts this long before sunrise
    eveningTailMinutes: 15, // an evening session ends this long after sunset
  },
  // How clients can pay. Zelle has no fees; the photographer confirms each payment (one tap, from the email or Admin).
  payments: { zelle: { enabled: false, recipient: '', name: '', holdHours: 24, qr: null } },
  // Photos behind every page, shown one after another with a slow fade. Each: { original, web, thumb, width, height }.
  siteBackground: { photos: [] },
  terms: 'The deposit holds your date and comes off your total. Reschedule free up to 72 hours before your session. Cancellations within 72 hours keep the deposit. The balance is due before your photos can be downloaded: pay it at the shoot or online in your gallery. You may use your photos personally; I may share a few in my portfolio unless you ask me not to.',
};

let db = null;

function init(file) {
  if (db) db.close();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // Columns added after the first release (an existing database gets them here, once).
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('packages', 'image_json')) db.exec("ALTER TABLE packages ADD COLUMN image_json TEXT NOT NULL DEFAULT ''");
  // Watermarked proof copies of each client photo (watermark.js).
  if (!has('photos', 'wm')) db.exec("ALTER TABLE photos ADD COLUMN wm TEXT NOT NULL DEFAULT ''; ALTER TABLE photos ADD COLUMN wm_thumb TEXT NOT NULL DEFAULT ''");
  // The balance: once paid (online or marked by the photographer), the client's clean photos unlock.
  // Zelle: how the deposit is paid, the reference the client puts in the memo, and when they said they'd sent it.
  if (!has('bookings', 'pay_method')) db.exec("ALTER TABLE bookings ADD COLUMN pay_method TEXT NOT NULL DEFAULT 'card'; ALTER TABLE bookings ADD COLUMN ref_code TEXT; ALTER TABLE bookings ADD COLUMN zelle_sent_at TEXT; ALTER TABLE bookings ADD COLUMN balance_zelle_sent_at TEXT; CREATE UNIQUE INDEX IF NOT EXISTS bookings_ref ON bookings(ref_code) WHERE ref_code IS NOT NULL;");
  // An offer: a package made for one client, reached only by its private link (never listed on the site).
  if (!has('packages', 'offer')) db.exec('ALTER TABLE packages ADD COLUMN offer INTEGER NOT NULL DEFAULT 0');
  if (!has('bookings', 'balance_paid_at')) db.exec('ALTER TABLE bookings ADD COLUMN balance_paid_at TEXT; ALTER TABLE bookings ADD COLUMN balance_session_id TEXT; ALTER TABLE bookings ADD COLUMN balance_paid_by TEXT');
  if (!get('SELECT 1 FROM packages LIMIT 1')) {
    for (const p of SEED_PACKAGES) {
      run('INSERT INTO packages (slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, sort) VALUES (?,?,?,?,?,?,?,?,?)',
        [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, p.sort]);
    }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
  }
  return db;
}

const conn = () => { if (!db) throw new Error('db.init() first'); return db; };
const get = (sql, params = []) => conn().prepare(sql).get(...params);
const all = (sql, params = []) => conn().prepare(sql).all(...params);
const run = (sql, params = []) => conn().prepare(sql).run(...params);

/** Runs fn inside one transaction: all its writes land together or not at all. */
function tx(fn) {
  conn().exec('BEGIN IMMEDIATE');
  try { const r = fn(); conn().exec('COMMIT'); return r; } catch (e) { conn().exec('ROLLBACK'); throw e; }
}

function setting(key) {
  const r = get('SELECT value FROM settings WHERE key = ?', [key]);
  const base = DEFAULT_SETTINGS[key];
  if (!r) return base;
  const v = JSON.parse(r.value);
  return base && typeof base === 'object' && !Array.isArray(base) ? Object.assign({}, base, v) : v;
}
function saveSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
}

const nowIso = () => new Date().toISOString();

module.exports = { init, get, all, run, tx, setting, saveSetting, nowIso, PIPELINE, ACTIVE, STATUSES, DEFAULT_SETTINGS };

'use strict';
/* =====================================================================
   routes.js — the JSON API.

   Public (the booking flow):
     GET  /api/site                     business name and booking terms
     GET  /api/packages                 what can be booked
     GET  /api/availability             times for a package (?package=slug&from=YYYY-MM-DD&days=42)
     POST /api/bookings                 hold a time and start the deposit (needs an Idempotency-Key header)
     GET  /api/bookings/:token          a client's own booking (the token is private, from their link)
     POST /api/bookings/:token/release  the client left checkout without paying: free their time at once
     POST /api/bookings/:token/prep     the prep questionnaire
     POST /api/stripe/webhook           Stripe says a deposit was paid
     GET  /api/dev/pay/:token           development only: pretend the deposit was paid
   Admin (logged in):
     POST /api/admin/login · /logout · GET /me
     GET  /api/admin/bookings           the pipeline
     POST /api/admin/bookings/:id/status · /deliver · /cancel · /undo
     GET/PUT /api/admin/settings
     POST /api/admin/packages · PUT /api/admin/packages/:id
   ===================================================================== */
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const bookings = require('./bookings');
const availability = require('./availability');
const payments = require('./payments');
const { HttpError, createRouter } = require('./http');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const longText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};

const PUBLIC_PACKAGE = 'id, slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, bg_video, bg_poster';
const activePackage = (slug) => db.get(`SELECT * FROM packages WHERE slug = ? AND active = 1`, [String(slug || '')]);

// Two copies of the same request at once (a double tap): the second waits for the first and gets the same answer.
const inFlight = new Map();

function build() {
  const r = createRouter();

  /* ---------- public ---------- */
  r.get('/api/site', (req, res) => res.json(200, { businessName: config.businessName, terms: db.setting('terms') }));

  r.get('/api/packages', (req, res) => {
    res.json(200, { packages: db.all(`SELECT ${PUBLIC_PACKAGE} FROM packages WHERE active = 1 ORDER BY sort, id`) });
  });

  r.get('/api/availability', (req, res) => {
    const pkg = activePackage(req.query.package);
    if (!pkg) throw new HttpError(404, 'No such package.');
    const today = availability.localDate(new Date());
    const from = availability.isYmd(req.query.from) && req.query.from > today ? req.query.from : today;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 42, 1), 62);
    res.json(200, { timezone: config.timezone, from, days: availability.forPackage(pkg, from, days) });
  });

  r.post('/api/bookings', async (req, res) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9-]{16,100}$/.test(key)) throw new HttpError(400, 'Missing Idempotency-Key.');
    const done = bookings.recall('book:' + key);
    if (done) return res.json(done.status, done.body);
    if (!inFlight.has(key)) inFlight.set(key, placeBooking(req.body, key).finally(() => inFlight.delete(key)));
    const out = await inFlight.get(key);
    res.json(out.status, out.body);
  });

  r.get('/api/bookings/:token', (req, res) => {
    const b = bookings.byToken(req.params.token);
    if (!b || b.status === 'expired') throw new HttpError(404, 'We couldn’t find that booking.');
    res.json(200, bookings.publicView(b));
  });

  r.post('/api/bookings/:token/release', (req, res) => {
    const b = bookings.byToken(req.params.token);
    if (b && b.status === 'hold') bookings.releaseHold(b.id);
    res.json(200, { ok: true });
  });

  r.post('/api/bookings/:token/prep', (req, res) => {
    res.json(200, bookings.publicView(bookings.savePrep(req.params.token, req.body)));
  });

  r.post('/api/stripe/webhook', (req, res) => {
    const event = payments.verifyWebhook(req.rawBody, req.headers['stripe-signature']);
    if (!event) throw new HttpError(400, 'Bad signature.');
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data && event.data.object;
      if (s && s.payment_status === 'paid') bookings.markPaid(s.client_reference_id || (s.metadata || {}).booking, s.id);
    }
    res.json(200, { received: true });
  }, { raw: true, bodyLimit: 512 * 1024 });

  r.get('/api/dev/pay/:token', (req, res) => {
    if (!payments.devMode()) throw new HttpError(404, 'Not found.');
    bookings.markPaid(req.params.token, null);
    res.redirect(`/booked?b=${encodeURIComponent(req.params.token)}`);
  });

  /* ---------- admin ---------- */
  r.post('/api/admin/login', (req, res) => auth.login(req, res));
  r.post('/api/admin/logout', (req, res) => auth.logout(req, res));
  r.get('/api/admin/me', (req, res) => res.json(200, { admin: auth.isAdmin(req) }));

  const admin = (fn) => (req, res) => { auth.requireAdmin(req); return fn(req, res); };

  r.get('/api/admin/bookings', admin((req, res) => res.json(200, { bookings: bookings.adminList() })));
  r.post('/api/admin/bookings/:id/status', admin((req, res) => res.json(200, { booking: bookings.setStatus(Number(req.params.id), String(req.body.status || '')) })));
  r.post('/api/admin/bookings/:id/deliver', admin((req, res) => res.json(200, bookings.deliver(Number(req.params.id), req.body.galleryUrl))));
  r.post('/api/admin/bookings/:id/cancel', admin((req, res) => res.json(200, bookings.cancel(Number(req.params.id)))));
  r.post('/api/admin/bookings/:id/undo', admin((req, res) => {
    res.json(200, { booking: bookings.undo(Number(req.params.id), String(req.body.action || ''), String(req.body.previous || '')) });
  }));

  r.get('/api/admin/settings', admin((req, res) => {
    res.json(200, { availability: db.setting('availability'), terms: db.setting('terms'), packages: db.all('SELECT * FROM packages ORDER BY sort, id') });
  }));
  r.put('/api/admin/settings', admin((req, res) => {
    if (req.body.availability) db.saveSetting('availability', cleanAvailability(req.body.availability));
    if (req.body.terms !== undefined) db.saveSetting('terms', longText(req.body.terms, 3000));
    res.json(200, { availability: db.setting('availability'), terms: db.setting('terms') });
  }));
  r.post('/api/admin/packages', admin((req, res) => {
    const p = cleanPackage(req.body);
    const out = db.run(`INSERT INTO packages (slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, bg_video, bg_poster, sort, active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, p.bg_video, p.bg_poster, p.sort, p.active]);
    res.json(200, { package: db.get('SELECT * FROM packages WHERE id = ?', [out.lastInsertRowid]) });
  }));
  r.put('/api/admin/packages/:id', admin((req, res) => {
    const id = Number(req.params.id);
    if (!db.get('SELECT 1 FROM packages WHERE id = ?', [id])) throw new HttpError(404, 'No such package.');
    const p = cleanPackage(req.body);
    db.run(`UPDATE packages SET slug=?, name=?, summary=?, minutes=?, photos=?, turnaround_days=?, price_cents=?, deposit_cents=?, bg_video=?, bg_poster=?, sort=?, active=? WHERE id=?`,
      [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, p.bg_video, p.bg_poster, p.sort, p.active, id]);
    res.json(200, { package: db.get('SELECT * FROM packages WHERE id = ?', [id]) });
  }));

  return r;
}

/** Holds the time, then starts Stripe checkout. Returns { status, body } and remembers it under the request key. */
async function placeBooking(body, key) {
  const pkg = activePackage(body.package);
  if (!pkg) return { status: 404, body: { error: 'That package isn’t available.' } };
  const name = text(body.name, 100);
  const email = text(body.email, 200).toLowerCase();
  const phone = text(body.phone, 40);
  const notes = longText(body.notes, 1000);
  if (name.length < 2) return { status: 400, body: { error: 'Add your name.', field: 'name' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'Check your email address.', field: 'email' } };
  if (body.agree !== true) return { status: 400, body: { error: 'Please agree to the booking terms.', field: 'agree' } };

  let hold;
  try { hold = bookings.createHold({ pkg, slotKey: String(body.slot || ''), name, email, phone, notes }); } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: Object.assign({ error: e.message }, e.extra) };
    throw e;
  }
  let checkout;
  try { checkout = await payments.startCheckout(hold, pkg, key); } catch (e) {
    bookings.releaseHold(hold.id);
    console.error('checkout:', e.message);
    return { status: 503, body: { error: e.message.startsWith('Online booking') ? e.message : 'Payment couldn’t start. Try again in a minute.' } };
  }
  bookings.attachCheckout(hold.id, checkout.sessionId);
  const out = { status: 200, body: { token: hold.token, checkoutUrl: checkout.url, holdExpiresAt: hold.hold_expires_at } };
  bookings.remember('book:' + key, out.status, out.body);
  return out;
}

function cleanAvailability(a) {
  const days = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  return {
    morning: days(a.morning),
    evening: days(a.evening),
    weeklyCap: int(a.weeklyCap, 1, 50, 'Weekly cap'),
    minNoticeHours: int(a.minNoticeHours, 0, 720, 'Notice'),
    maxDaysAhead: int(a.maxDaysAhead, 1, 365, 'Days ahead'),
    blockedDates: [...new Set((Array.isArray(a.blockedDates) ? a.blockedDates : []).filter(availability.isYmd))].sort(),
    morningLeadMinutes: int(a.morningLeadMinutes, 0, 90, 'Morning lead'),
    eveningTailMinutes: int(a.eveningTailMinutes, 0, 90, 'Evening tail'),
  };
}

function cleanPackage(b) {
  const media = (v) => { const s = text(v, 300); if (s && !/^(\/media\/[A-Za-z0-9._-]+|https:\/\/\S+)$/.test(s)) throw new HttpError(400, 'Background files go in /media/ (or a full https:// link).'); return s; };
  const p = {
    slug: text(b.slug, 40).toLowerCase(),
    name: text(b.name, 60),
    summary: text(b.summary, 200),
    minutes: int(b.minutes, 15, 480, 'Length (minutes)'),
    photos: int(b.photos, 1, 2000, 'Photos'),
    turnaround_days: int(b.turnaround_days, 1, 120, 'Turnaround (days)'),
    price_cents: int(b.price_cents, 0, 10000000, 'Price'),
    deposit_cents: int(b.deposit_cents, 0, 10000000, 'Deposit'),
    bg_video: media(b.bg_video),
    bg_poster: media(b.bg_poster),
    sort: int(b.sort == null ? 0 : b.sort, 0, 1000, 'Order'),
    active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (!/^[a-z0-9-]{2,40}$/.test(p.slug)) throw new HttpError(400, 'The link name uses lowercase letters, numbers and dashes.');
  if (p.name.length < 2) throw new HttpError(400, 'Give the package a name.');
  if (p.deposit_cents > p.price_cents) throw new HttpError(400, 'The deposit can’t be more than the price.');
  if (p.deposit_cents < 50 && p.price_cents > 0) throw new HttpError(400, 'Stripe needs a deposit of at least $0.50.');
  return p;
}

module.exports = { build };

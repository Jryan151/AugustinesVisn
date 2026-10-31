'use strict';
/* =====================================================================
   routes.js — the JSON API.

   Public (the booking flow):
     GET  /api/health                   ok when the app and its database answer
     GET  /api/site                     business name and booking terms
     GET  /api/packages                 what can be booked
     GET  /api/portfolio/:slug          a package's example shots (and an offer: a package made for one client, at /offer/<slug>)
     GET  /api/availability             times for a package (?package=slug&from=YYYY-MM-DD&days=42)
     POST /api/bookings                 hold a time and start the deposit (needs an Idempotency-Key header); in person: email a code
     POST /api/bookings/verify          in person: the code from the email books the time
     POST /api/requests                 "Request another time": the photographer books it or declines it (Admin)
     GET  /api/bookings/:token          a client's own booking (the token is private, from their link)
     POST /api/bookings/:token/release  the client left checkout without paying: free their time at once
     POST /api/bookings/:token/prep     the prep questionnaire
     POST /api/stripe/webhook           Stripe says a deposit was paid
     GET  /api/dev/pay/:token           development only: pretend the deposit was paid
     GET  /api/gallery/:token           a delivered client's photos (list)
     GET  /g/:token/:photo/:size        one photo (thumb, web, original = download)
     GET  /g/:token/all.zip             every photo in one download (once the balance is paid)
     POST /api/gallery/:token/pay       pay the balance (Stripe), which unlocks the clean photos
     GET  /api/dev/pay-balance/:token   development only: pretend the balance was paid
     POST /api/bookings/:token/zelle-sent · POST /api/gallery/:token/zelle-sent   the client says they sent it by Zelle
     GET/POST /api/confirm/:code (· /undo)   the photographer's signed one-tap Confirm (Zelle email)
   Admin (logged in):
     POST /api/admin/login · /logout · GET /me
     GET  /api/admin/bookings           the pipeline
     POST /api/admin/bookings/:id/status · /deliver · /cancel · /balance-paid · /undo
     GET/PUT /api/admin/settings
     POST /api/admin/packages · PUT /api/admin/packages/:id · PUT /api/admin/packages/order { ids }
     PUT/DELETE /api/admin/packages/:id/image        the photo behind a package's card (PUT = raw image upload)
     PUT /api/admin/packages/:id/image/frame · PUT /api/admin/site/background/:key/frame   nudge: { fx, fy, zoom }
     GET/PUT /api/admin/packages/:id/portfolio · DELETE /api/admin/portfolio/:id · POST …/:id/first
     GET/PUT /api/admin/bookings/:id/photos          a client's finished photos (PUT = one raw image per request)
     DELETE /api/admin/photos/:id · POST …/restore · GET /api/admin/photos/:id/:size
     GET /api/admin/site · PUT /api/admin/site/background · DELETE …/:key · POST …/:key/first · PUT /api/admin/site/admin-background
     GET /api/admin/clients · PUT /api/admin/clients/notes
     GET /api/admin/email · POST /api/admin/email/test
     GET/PUT /api/admin/payments · PUT/DELETE /api/admin/payments/zelle-qr · POST /api/admin/bookings/:id/zelle-received
   ===================================================================== */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const bookings = require('./bookings');
const availability = require('./availability');
const payments = require('./payments');
const galleries = require('./galleries');
const sitemedia = require('./sitemedia');
const clients = require('./clients');
const zelle = require('./zelle');
const inperson = require('./inperson');
const requests = require('./requests');
const context = require('./context');

/** How clients can pay right now: card (Stripe set up, or the development stand-in) and/or Zelle. */
const methods = () => ({ card: payments.enabled() || payments.devMode(), zelle: zelle.enabled(), inPerson: inperson.enabled() });
const { HttpError, createRouter } = require('./http');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const longText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};

const PUBLIC_PACKAGE = 'id, slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, image_json, offer, (SELECT COUNT(*) FROM portfolio pf WHERE pf.package_id = packages.id) AS portfolio_count';
// A package as the public sees it: its card photo as addresses, not the stored file names.
const publicPackage = (p) => { const out = Object.assign({}, p, { image: sitemedia.view(sitemedia.packageImage(p)) }); delete out.image_json; return out; };
const activePackage = (slug) => db.get(`SELECT * FROM packages WHERE slug = ? AND active = 1`, [String(slug || '')]);

// Two copies of the same request at once (a double tap): the second waits for the first and gets the same answer.
const inFlight = new Map();

function build() {
  const r = createRouter();

  /* ---------- public ---------- */
  // For the deploy check and uptime monitors: answers only when the database does.
  r.get('/api/health', (req, res) => { db.get('SELECT 1'); res.json(200, { ok: true }); });

  // Where each nudged photo sits (see sitemedia.siteCss). Pages ask for it with a stamp, so it can be kept a year.
  r.get('/site.css', (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(sitemedia.siteCss());
  });

  r.get('/api/site', (req, res) => res.json(200, { demo: context.isDemo(), businessName: config.businessName, terms: db.setting('terms'), payments: methods(), zelle: zelle.publicInfo(), zelleHoldHours: zelle.settings().holdHours }));

  r.get('/api/packages', (req, res) => {
    res.json(200, { packages: db.all(`SELECT ${PUBLIC_PACKAGE} FROM packages WHERE active = 1 AND offer = 0 ORDER BY sort, id`).map(publicPackage) });
  });

  // A package's portfolio: its example shots, for /portfolio/<slug>. An offer's private page (/offer/<slug>) uses it too.
  r.get('/api/portfolio/:slug', (req, res) => {
    const pkg = db.get(`SELECT ${PUBLIC_PACKAGE} FROM packages WHERE slug = ? AND active = 1`, [String(req.params.slug)]);
    if (!pkg) throw new HttpError(404, 'No such package.');
    res.json(200, { package: publicPackage(pkg), photos: sitemedia.portfolio(pkg.id) });
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

  // "Request another time": a date, time and note for the photographer to book or decline. Nothing is held.
  r.post('/api/requests', (req, res) => {
    const pkg = activePackage(req.body.package);
    if (!pkg) throw new HttpError(404, 'That package isn’t available.');
    const name = text(req.body.name, 100); const email = text(req.body.email, 200).toLowerCase();
    if (name.length < 2) throw new HttpError(400, 'Add your name.', { field: 'req-name' });
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Check your email address.', { field: 'req-email' });
    res.json(200, requests.create(pkg, { date: String(req.body.date || ''), time: String(req.body.time || ''), note: longText(req.body.note, 1000), name, email, phone: text(req.body.phone, 40) }));
  });

  // In person: the code from the client's email books their time. Answers { token, checkoutUrl } like a paid booking.
  r.post('/api/bookings/verify', (req, res) => {
    const b = inperson.verify(req.body.verify, req.body.code);
    res.json(200, { token: b.token, checkoutUrl: `/booked?b=${b.token}` });
  });

  r.get('/api/bookings/:token', (req, res) => {
    const b = bookings.byToken(req.params.token);
    if (!b || (b.status === 'expired' && b.pay_method !== 'zelle')) throw new HttpError(404, 'We couldn’t find that booking.');
    const view = bookings.publicView(b);
    if (b.pay_method === 'zelle' && ['hold', 'expired'].includes(b.status)) view.zelle = zelle.publicInfo();
    res.json(200, view);
  });

  r.post('/api/bookings/:token/release', (req, res) => {
    const b = bookings.byToken(req.params.token);
    if (b && b.status === 'hold') bookings.releaseHold(b.id);
    res.json(200, { ok: true });
  });

  r.post('/api/bookings/:token/zelle-sent', (req, res) => {
    const b = bookings.byToken(req.params.token);
    if (!b) throw new HttpError(404, 'We couldn\u2019t find that booking.');
    zelle.clientSent(b, 'deposit');
    res.json(200, bookings.publicView(bookings.byToken(req.params.token)));
  });

  r.post('/api/bookings/:token/prep', (req, res) => {
    res.json(200, bookings.publicView(bookings.savePrep(req.params.token, req.body)));
  });

  r.post('/api/stripe/webhook', (req, res) => {
    const event = payments.verifyWebhook(req.rawBody, req.headers['stripe-signature']);
    if (!event) throw new HttpError(400, 'Bad signature.');
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data && event.data.object;
      if (s && s.payment_status === 'paid') {
        const token = s.client_reference_id || (s.metadata || {}).booking;
        if ((s.metadata || {}).kind === 'balance') { const b = bookings.byToken(token); if (b) bookings.markBalancePaid(b, 'online', s.id); }
        else bookings.markPaid(token, s.id);
      }
    }
    res.json(200, { received: true });
  }, { raw: true, bodyLimit: 512 * 1024 });

  r.get('/api/dev/pay-balance/:token', (req, res) => {
    if (!payments.devMode()) throw new HttpError(404, 'Not found.');
    const b = bookings.byToken(req.params.token);
    if (b) bookings.markBalancePaid(b, 'online', null);
    res.redirect(`/gallery/${encodeURIComponent(req.params.token)}?paid=1`);
  });

  r.get('/api/dev/pay/:token', (req, res) => {
    if (!payments.devMode()) throw new HttpError(404, 'Not found.');
    bookings.markPaid(req.params.token, null);
    res.redirect(`/booked?b=${encodeURIComponent(req.params.token)}`);
  });

  /* ---------- a delivered client's gallery ---------- */
  r.get('/api/gallery/:token', (req, res) => {
    const b = galleries.openGallery(req.params.token);
    const pkg = db.get('SELECT name FROM packages WHERE id = ?', [b.package_id]);
    res.json(200, { businessName: config.businessName, name: b.client_name, package: pkg.name, when: require('./mail').when(b),
      locked: b.locked, balanceCents: b.locked ? b.price_cents - b.deposit_cents : 0, canPayOnline: payments.enabled() || payments.devMode(),
      zelle: b.locked ? zelle.publicInfo() : null, ref: b.locked && zelle.enabled() ? zelle.refFor(b) : null, zelleSent: !!b.balance_zelle_sent_at,
      photos: galleries.list(b.id) });
  });
  r.post('/api/gallery/:token/zelle-sent', (req, res) => {
    const b = galleries.openGallery(req.params.token);
    if (!b.locked) return res.json(200, { paid: true });
    zelle.clientSent(b, 'balance');
    res.json(200, { sent: true });
  });
  // Pay the balance from the gallery (Stripe). Same Idempotency-Key, same checkout: a double tap never pays twice.
  r.post('/api/gallery/:token/pay', async (req, res) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9-]{16,100}$/.test(key)) throw new HttpError(400, 'Missing Idempotency-Key.');
    const done = bookings.recall('balance:' + key);
    if (done) return res.json(done.status, done.body);
    const b = galleries.openGallery(req.params.token);
    if (!b.locked) return res.json(200, { paid: true });
    const pkg = db.get('SELECT * FROM packages WHERE id = ?', [b.package_id]);
    let checkout;
    try { checkout = await payments.startBalanceCheckout(b, pkg, key); } catch (e) {
      console.error('balance checkout:', e.message);
      throw new HttpError(503, e.message.startsWith('Online payment') ? e.message : 'Payment couldn\u2019t start. Try again in a minute.');
    }
    const body = { checkoutUrl: checkout.url };
    bookings.remember('balance:' + key, 200, body);
    res.json(200, body);
  });
  r.get('/g/:token/all.zip', async (req, res) => {
    const b = galleries.openGallery(req.params.token);
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await galleries.sendZip(res, b, `${slug(b.client_name) || 'photos'}-${slug(config.businessName)}.zip`);
  });
  r.get('/g/:token/:photo/:size', (req, res) => {
    const b = galleries.openGallery(req.params.token);
    const p = db.get('SELECT * FROM photos WHERE id = ? AND booking_id = ? AND deleted_at IS NULL', [Number(req.params.photo), b.id]);
    if (!p) throw new HttpError(404, 'Not found.');
    return galleries.sendPhoto(res, p, req.params.size, b.locked);
  });

  /* ---------- the photographer's one-tap Confirm link (from the Zelle email; signed, no login) ---------- */
  r.get('/api/confirm/:code', (req, res) => { const { b, what } = zelle.readCode(req.params.code); res.json(200, zelle.describe(b, what)); });
  r.post('/api/confirm/:code', (req, res) => {
    const { b, what } = zelle.readCode(req.params.code);
    if (what === 'deposit' && b.status === 'cancelled') throw new HttpError(409, 'This booking was cancelled, so there\u2019s nothing to confirm.');
    const before = b.status;
    const after = bookings.confirmZelle(b, what);
    res.json(200, Object.assign(zelle.describe(after, what), { needsRefund: after.status === 'needs_refund', was: before }));
  });
  r.post('/api/confirm/:code/undo', (req, res) => {
    const { b, what } = zelle.readCode(req.params.code);
    const after = bookings.undo(b.id, what === 'deposit' ? 'zelle' : 'balance', b.status);
    res.json(200, zelle.describe(after, what));
  });

  /* ---------- admin ---------- */
  r.post('/api/admin/login', (req, res) => auth.login(req, res));
  r.post('/api/admin/logout', (req, res) => auth.logout(req, res));
  r.get('/api/admin/me', (req, res) => res.json(200, { admin: auth.isAdmin(req), demo: context.isDemo() }));

  const admin = (fn) => (req, res) => { auth.requireAdmin(req); return fn(req, res); };
  // The Demo switch: this browser (the logged-in photographer's) sees the sample data until it's switched off.
  // The first time, the sample data is built. Everyone else keeps seeing the real site.
  r.post('/api/admin/demo', admin(async (req, res) => {
    const on = req.body.on === true;
    if (on) await context.run(true, () => require('./demo').prepare());
    res.setHeader('Set-Cookie', `av_demo=${on ? '1' : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${on ? 12 * 3600 : 0}${config.isProd ? '; Secure' : ''}`);
    res.json(200, { demo: on });
  }));
  // Puts every sample booking, photo and setting back as it started. Only from inside the demo.
  r.post('/api/admin/demo/reset', admin(async (req, res) => {
    if (!context.isDemo()) throw new HttpError(400, 'Switch the demo on first.');
    res.json(200, await require('./demo').reset());
  }));

  r.get('/api/admin/bookings', admin((req, res) => res.json(200, { bookings: bookings.adminList(), requests: requests.pending() })));
  r.post('/api/admin/requests/:id/approve', admin((req, res) => res.json(200, { booking: requests.approve(Number(req.params.id), req.body.time) })));
  r.post('/api/admin/requests/:id/decline', admin((req, res) => res.json(200, requests.decline(Number(req.params.id)))));
  r.post('/api/admin/requests/:id/undo', admin((req, res) => res.json(200, requests.undo(Number(req.params.id)))));
  r.post('/api/admin/bookings/:id/status', admin((req, res) => res.json(200, { booking: bookings.setStatus(Number(req.params.id), String(req.body.status || '')) })));
  r.post('/api/admin/bookings/:id/deliver', admin((req, res) => res.json(200, bookings.deliver(Number(req.params.id), req.body.galleryUrl))));
  r.post('/api/admin/bookings/:id/cancel', admin((req, res) => res.json(200, bookings.cancel(Number(req.params.id)))));
  r.post('/api/admin/bookings/:id/balance-paid', admin((req, res) => res.json(200, { booking: bookings.markBalancePaid(bookings.byId(Number(req.params.id)), 'marked') })));
  r.post('/api/admin/bookings/:id/undo', admin((req, res) => {
    res.json(200, { booking: bookings.undo(Number(req.params.id), String(req.body.action || ''), String(req.body.previous || '')) });
  }));

  // Client photos.
  r.get('/api/admin/bookings/:id/photos', admin((req, res) => res.json(200, { photos: galleries.list(Number(req.params.id)) })));
  r.put('/api/admin/bookings/:id/photos', admin(async (req, res) => res.json(200, { photo: await galleries.add(Number(req.params.id), req) })), { stream: true });
  r.delete('/api/admin/photos/:id', admin((req, res) => { galleries.remove(Number(req.params.id)); res.json(200, { ok: true }); }));
  r.post('/api/admin/photos/:id/restore', admin((req, res) => { galleries.restore(Number(req.params.id)); res.json(200, { ok: true }); }));
  r.get('/api/admin/photos/:id/:size', admin((req, res) => {
    const p = db.get('SELECT * FROM photos WHERE id = ?', [Number(req.params.id)]);
    if (!p) throw new HttpError(404, 'Not found.');
    return galleries.sendPhoto(res, p, req.params.size);
  }));

  // The site's look.
  r.get('/api/admin/site', admin((req, res) => res.json(200, { background: sitemedia.backgroundPhotos().map(sitemedia.view), max: sitemedia.MAX_BG, adminBackground: sitemedia.adminBackground() })));
  // Behind Admin: { mode: 'off' | 'site' | 'photo', key }. Answers with the new layer, so the page changes at once.
  r.put('/api/admin/site/admin-background', admin((req, res) => res.json(200, { adminBackground: sitemedia.saveAdminBackground(req.body), markup: sitemedia.adminBackgroundMarkup() })));
  r.put('/api/admin/site/background', admin(async (req, res) => res.json(200, { background: await sitemedia.addBackground(req) })), { stream: true });
  r.delete('/api/admin/site/background/:key', admin((req, res) => res.json(200, { background: sitemedia.removeBackground(req.params.key) })));
  r.post('/api/admin/site/background/:key/first', admin((req, res) => res.json(200, { background: sitemedia.firstBackground(req.params.key) })));
  r.put('/api/admin/site/background/:key/frame', admin((req, res) => res.json(200, { background: sitemedia.frameBackground(req.params.key, req.body) })));
  r.get('/api/admin/packages/:id/portfolio', admin((req, res) => res.json(200, { photos: sitemedia.portfolio(Number(req.params.id)), max: sitemedia.MAX_PORTFOLIO })));
  r.put('/api/admin/packages/:id/portfolio', admin(async (req, res) => res.json(200, { photos: await sitemedia.addPortfolio(Number(req.params.id), req) })), { stream: true });
  r.delete('/api/admin/portfolio/:id', admin((req, res) => res.json(200, { photos: sitemedia.removePortfolio(Number(req.params.id)) })));
  r.post('/api/admin/portfolio/:id/first', admin((req, res) => res.json(200, { photos: sitemedia.firstPortfolio(Number(req.params.id)) })));
  r.put('/api/admin/packages/:id/image/frame', admin((req, res) => res.json(200, { image: sitemedia.framePackageImage(Number(req.params.id), req.body) })));
  r.put('/api/admin/packages/:id/image', admin(async (req, res) => res.json(200, { image: await sitemedia.setPackageImage(Number(req.params.id), req) })), { stream: true });
  r.delete('/api/admin/packages/:id/image', admin((req, res) => { sitemedia.removePackageImage(Number(req.params.id)); res.json(200, { ok: true }); }));

  // Payments: Zelle details (and whether card is set up).
  r.get('/api/admin/payments', admin((req, res) => res.json(200, { methods: methods(), stripe: payments.enabled(), zelle: zelleAdmin() })));
  r.put('/api/admin/payments', admin((req, res) => { if (req.body.zelle) zelle.saveSettings(req.body.zelle); if (req.body.inPerson) inperson.saveSettings(req.body.inPerson); res.json(200, { methods: methods(), stripe: payments.enabled(), zelle: zelleAdmin() }); }));
  r.put('/api/admin/payments/zelle-qr', admin(async (req, res) => { await zelle.setQr(req); res.json(200, { zelle: zelleAdmin() }); }), { stream: true });
  r.delete('/api/admin/payments/zelle-qr', admin((req, res) => { zelle.removeQr(); res.json(200, { zelle: zelleAdmin() }); }));
  r.post('/api/admin/bookings/:id/zelle-received', admin((req, res) => {
    const b = bookings.byId(Number(req.params.id));
    if (!b) throw new HttpError(404, 'No such booking.');
    res.json(200, { booking: bookings.confirmZelle(b, 'deposit') });
  }));

  // Email: is it set up, and send a test to the photographer's own address.
  r.get('/api/admin/email', admin((req, res) => res.json(200, require('./mail').status())));
  r.post('/api/admin/email/test', admin(async (req, res) => {
    const mail = require('./mail');
    if (!config.adminEmail) throw new HttpError(400, 'Set ADMIN_EMAIL in the server\u2019s .env first: the test goes there.');
    const id = mail.queueNote({ kind: 'test', to: config.adminEmail, subject: `Test email from ${config.businessName}`,
      body: `This is a test from your booking site (${config.baseUrl}).\n\nIf you\u2019re reading this, clients will get their confirmations, reminders and gallery links.` });
    await mail.processOutbox();
    const row = db.get('SELECT status, last_error FROM outbox WHERE id = ?', [id]);
    if (row.status === 'sent') return res.json(200, { sent: true, to: config.adminEmail, viaResend: !!config.resendApiKey });
    throw new HttpError(502, `It didn\u2019t send: ${row.last_error || 'unknown error'}. It will retry on its own.`);
  }));

  // Clients.
  r.get('/api/admin/clients', admin((req, res) => res.json(200, { clients: clients.list() })));
  r.put('/api/admin/clients/notes', admin((req, res) => { clients.saveNotes(req.body.email, req.body.notes); res.json(200, { ok: true }); }));

  r.get('/api/admin/settings', admin((req, res) => {
    res.json(200, { availability: db.setting('availability'), terms: db.setting('terms'), packages: db.all('SELECT *, (SELECT COUNT(*) FROM portfolio pf WHERE pf.package_id = packages.id) AS portfolio_count FROM packages ORDER BY sort, id').map(publicPackage) });
  }));
  r.put('/api/admin/settings', admin((req, res) => {
    if (req.body.availability) db.saveSetting('availability', cleanAvailability(req.body.availability));
    if (req.body.terms !== undefined) db.saveSetting('terms', longText(req.body.terms, 3000));
    res.json(200, { availability: db.setting('availability'), terms: db.setting('terms') });
  }));
  // The order packages appear in, everywhere (home page, booking): the full list of ids, first to last. Offers aren't listed, so they have no place in it.
  r.put('/api/admin/packages/order', admin((req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    const all = db.all('SELECT id FROM packages WHERE offer = 0').map((r) => r.id);
    if (ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((i) => all.includes(i))) {
      throw new HttpError(400, 'Send every package once, in the new order.');
    }
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE packages SET sort = ? WHERE id = ?', [i + 1, id])));
    res.json(200, { packages: db.all('SELECT *, (SELECT COUNT(*) FROM portfolio pf WHERE pf.package_id = packages.id) AS portfolio_count FROM packages ORDER BY sort, id').map(publicPackage) });
  }));
  r.post('/api/admin/packages', admin((req, res) => {
    // An offer gets a link nobody could guess; it's the only way to reach it.
    const offer = req.body.offer === true ? 1 : 0;
    const p = cleanPackage(offer ? Object.assign({}, req.body, { slug: 'offer-' + crypto.randomBytes(9).toString('hex') }) : req.body);
    // A new package goes to the end of the list; the photographer moves it from there.
    const last = db.get('SELECT COALESCE(MAX(sort), 0) AS n FROM packages').n;
    const out = db.run(`INSERT INTO packages (slug, name, summary, minutes, photos, turnaround_days, price_cents, deposit_cents, sort, active, offer)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, last + 1, p.active, offer]);
    res.json(200, { package: publicPackage(db.get('SELECT * FROM packages WHERE id = ?', [out.lastInsertRowid])) });
  }));
  r.put('/api/admin/packages/:id', admin((req, res) => {
    const id = Number(req.params.id);
    const was = db.get('SELECT slug, offer FROM packages WHERE id = ?', [id]);
    if (!was) throw new HttpError(404, 'No such package.');
    // An offer keeps its link: it's already been sent.
    const p = cleanPackage(was.offer ? Object.assign({}, req.body, { slug: was.slug }) : req.body);
    // Saving a package never moves it: its place in the list is set only by the order below.
    db.run(`UPDATE packages SET slug=?, name=?, summary=?, minutes=?, photos=?, turnaround_days=?, price_cents=?, deposit_cents=?, active=? WHERE id=?`,
      [p.slug, p.name, p.summary, p.minutes, p.photos, p.turnaround_days, p.price_cents, p.deposit_cents, p.active, id]);
    res.json(200, { package: publicPackage(db.get('SELECT * FROM packages WHERE id = ?', [id])) });
  }));

  return r;
}

function zelleAdmin() {
  const z = zelle.settings();
  return { enabled: z.enabled, recipient: z.recipient, name: z.name, holdHours: z.holdHours, qr: z.qr ? { url: '/media/' + z.qr.web } : null };
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
  const can = methods();
  const KEY = { card: 'card', zelle: 'zelle', in_person: 'inPerson' };
  const method = KEY[body.method] ? body.method : can.card ? 'card' : can.zelle ? 'zelle' : 'in_person';
  if (!can[KEY[method]]) return { status: 503, body: { error: can.card || can.zelle || can.inPerson ? 'That way of paying isn\u2019t available. Pick another.' : 'Booking isn\u2019t open yet. Please email to book.' } };

  // In person: nothing is held until the client types the code from their email.
  if (method === 'in_person') {
    let out;
    try { out = { status: 200, body: Object.assign({ method }, inperson.start({ pkg, slotKey: String(body.slot || ''), name, email, phone, notes })) }; } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: Object.assign({ error: e.message }, e.extra) };
      throw e;
    }
    bookings.remember('book:' + key, out.status, out.body);
    return out;
  }

  let hold;
  try { hold = bookings.createHold({ pkg, slotKey: String(body.slot || ''), name, email, phone, notes, method }); } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: Object.assign({ error: e.message }, e.extra) };
    throw e;
  }
  // Zelle: no checkout. The client goes to their booking page, which shows who to pay and the memo reference.
  if (method === 'zelle') {
    const out = { status: 200, body: { token: hold.token, checkoutUrl: `/booked?b=${hold.token}`, holdExpiresAt: hold.hold_expires_at, method } };
    bookings.remember('book:' + key, out.status, out.body);
    return out;
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
  const p = {
    slug: text(b.slug, 40).toLowerCase(),
    name: text(b.name, 60),
    summary: text(b.summary, 200),
    minutes: int(b.minutes, 15, 480, 'Length (minutes)'),
    photos: int(b.photos, 1, 2000, 'Photos'),
    turnaround_days: int(b.turnaround_days, 1, 120, 'Turnaround (days)'),
    price_cents: int(b.price_cents, 0, 10000000, 'Price'),
    deposit_cents: int(b.deposit_cents, 0, 10000000, 'Deposit'),
    active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (!/^[a-z0-9-]{2,40}$/.test(p.slug)) throw new HttpError(400, 'The link name uses lowercase letters, numbers and dashes.');
  if (p.name.length < 2) throw new HttpError(400, 'Give the package a name.');
  if (p.deposit_cents > p.price_cents) throw new HttpError(400, 'The deposit can’t be more than the price.');
  if (p.deposit_cents < 50 && p.price_cents > 0) throw new HttpError(400, 'Stripe needs a deposit of at least $0.50.');
  return p;
}

module.exports = { build };

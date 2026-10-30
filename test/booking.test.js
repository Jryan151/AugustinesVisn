'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server');
const db = require('../src/db');
const mail = require('../src/mail');
const jobs = require('../src/jobs');

let server; let base;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Every weekday open in the evening, no notice needed, so tests don't depend on today's date.
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
});
test.after(() => server.close());

const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const key = () => crypto.randomUUID();
let slotIndex = 0;
async function freeSlot() {
  const r = await call('GET', '/api/availability?package=portrait&days=60');
  return r.data.days.flatMap((d) => d.slots)[slotIndex++].key;
}
const client = (slot, over) => Object.assign({ package: 'portrait', slot, name: 'Jane Doe', email: 'jane@example.com', agree: true }, over);

test('a booking: hold, same answer on retry, the time is gone for others, then paid and emailed', async () => {
  const slot = await freeSlot();
  const k = key();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': k });
  assert.equal(a.status, 200);
  assert.match(a.data.checkoutUrl, /^\/api\/dev\/pay\//);
  const again = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': k });
  assert.deepEqual(again.data, a.data, 'a retry gets the same booking, not a second one');
  const both = await Promise.all([1, 2].map(() => call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': k })));
  assert.ok(both.every((x) => x.data.token === a.data.token));
  const other = await call('POST', '/api/bookings', client(slot, { name: 'Bob' }), { 'Idempotency-Key': key() });
  assert.equal(other.status, 409);
  assert.equal(other.data.code, 'slot_taken');
  const avail = await call('GET', '/api/availability?package=portrait&days=60');
  assert.ok(!avail.data.days.flatMap((d) => d.slots).some((s) => s.key === slot), 'a held time is not offered');

  const pay = await call('GET', a.data.checkoutUrl);
  assert.equal(pay.status, 303);
  const view = await call('GET', '/api/bookings/' + a.data.token);
  assert.equal(view.data.status, 'booked');
  await call('GET', a.data.checkoutUrl); // paying twice changes nothing
  mail.sentInTests.length = 0;
  await mail.processOutbox(new Date(Date.now() + 1000));
  const kinds = mail.sentInTests.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['admin_new', 'confirmation']);
});

test('bad requests are refused with a reason', async () => {
  const slot = await freeSlot();
  assert.equal((await call('POST', '/api/bookings', client(slot))).status, 400, 'no Idempotency-Key');
  const noAgree = await call('POST', '/api/bookings', client(slot, { agree: false }), { 'Idempotency-Key': key() });
  assert.equal(noAgree.status, 400); assert.equal(noAgree.data.field, 'agree');
  const badEmail = await call('POST', '/api/bookings', client(slot, { email: 'nope' }), { 'Idempotency-Key': key() });
  assert.equal(badEmail.data.field, 'email');
  const notOffered = await call('POST', '/api/bookings', client('2020-01-01:evening'), { 'Idempotency-Key': key() });
  assert.equal(notOffered.status, 409);
});

test('an unpaid hold runs out, frees the time, and a late payment is flagged for refund (never double-booked)', async () => {
  const slot = await freeSlot();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  db.run("UPDATE bookings SET hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?", [a.data.token]);
  const b = await call('POST', '/api/bookings', client(slot, { email: 'b@example.com' }), { 'Idempotency-Key': key() });
  assert.equal(b.status, 200, 'the time is free again');
  await call('GET', b.data.checkoutUrl);
  await call('GET', a.data.checkoutUrl); // the first client pays late
  assert.equal(db.get('SELECT status FROM bookings WHERE token = ?', [a.data.token]).status, 'needs_refund');
  assert.equal(db.get('SELECT status FROM bookings WHERE token = ?', [b.data.token]).status, 'booked');
  assert.ok(db.get("SELECT 1 FROM outbox WHERE kind = 'admin_needs_refund'"));
});

test('leaving checkout releases the time at once', async () => {
  const slot = await freeSlot();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  await call('POST', `/api/bookings/${a.data.token}/release`, {});
  const b = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  assert.equal(b.status, 200);
});

test('Stripe webhook: only a genuine signature marks a booking paid', async () => {
  const slot = await freeSlot();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', client_reference_id: a.data.token } } });
  const forged = await fetch(base + '/api/stripe/webhook', { method: 'POST', body: event, headers: { 'Stripe-Signature': 't=1,v1=abc' } });
  assert.equal(forged.status, 400);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${event}`).digest('hex');
  const real = await fetch(base + '/api/stripe/webhook', { method: 'POST', body: event, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } });
  assert.equal(real.status, 200);
  const row = db.get('SELECT status, stripe_session_id FROM bookings WHERE token = ?', [a.data.token]);
  assert.deepEqual({ ...row }, { status: 'booked', stripe_session_id: 'cs_test_1' });
});

test('prep answers move a booking to prepped; reminders are queued once', async () => {
  const slot = await freeSlot();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  await call('GET', a.data.checkoutUrl);
  assert.equal((await call('POST', `/api/bookings/${a.data.token}/prep`, {})).status, 400);
  const p = await call('POST', `/api/bookings/${a.data.token}/prep`, { location: 'South Mountain', look: 'warm and natural' });
  assert.equal(p.data.status, 'prepped');
  const b = db.get('SELECT * FROM bookings WHERE token = ?', [a.data.token]);
  const twoDaysBefore = new Date(new Date(b.start_at).getTime() - 2 * 86400000);
  jobs.queueDue(twoDaysBefore); jobs.queueDue(twoDaysBefore);
  assert.equal(db.get("SELECT COUNT(*) n FROM outbox WHERE booking_id = ? AND kind = 'reminder3'", [b.id]).n, 1);
  jobs.queueDue(new Date(new Date(b.start_at).getTime() - 3600000));
  assert.equal(db.get("SELECT COUNT(*) n FROM outbox WHERE booking_id = ? AND kind = 'reminder1'", [b.id]).n, 1);
});

test('admin: login required; deliver and cancel can be undone before their email leaves', async () => {
  assert.equal((await call('GET', '/api/admin/bookings')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  const login = await call('POST', '/api/admin/login', { password: 'test-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const as = (m, p, b) => call(m, p, b, { Cookie: cookie });

  const slot = await freeSlot();
  const a = await call('POST', '/api/bookings', client(slot), { 'Idempotency-Key': key() });
  await call('GET', a.data.checkoutUrl);
  const id = db.get('SELECT id FROM bookings WHERE token = ?', [a.data.token]).id;

  assert.equal((await as('POST', `/api/admin/bookings/${id}/status`, { status: 'shot' })).data.booking.status, 'shot');
  assert.equal((await as('POST', `/api/admin/bookings/${id}/deliver`, { galleryUrl: 'http://not-secure' })).status, 400);
  const d = await as('POST', `/api/admin/bookings/${id}/deliver`, { galleryUrl: 'https://gallery.example.com/jane' });
  assert.equal(d.data.booking.status, 'delivered');
  assert.equal(d.data.previous, 'shot');
  await mail.processOutbox(); // the gallery email is still waiting out its 10 seconds
  const u = await as('POST', `/api/admin/bookings/${id}/undo`, { action: 'deliver', previous: 'shot' });
  assert.equal(u.data.booking.status, 'shot');
  assert.equal(db.get("SELECT status FROM outbox WHERE booking_id = ? AND kind = 'gallery'", [id]).status, 'cancelled');

  const c = await as('POST', `/api/admin/bookings/${id}/cancel`, {});
  assert.equal(c.data.booking.status, 'cancelled');
  await mail.processOutbox(new Date(Date.now() + 20000)); // after the wait, the email has gone
  const late = await as('POST', `/api/admin/bookings/${id}/undo`, { action: 'cancel', previous: 'shot' });
  assert.equal(late.status, 409, 'too late once the client has been emailed');
});

test('after an update, pages point at the new scripts and styles (never a stale copy)', async () => {
  for (const p of ['/', '/book', '/admin']) {
    const html = (await call('GET', p)).data;
    assert.match(html, /href="\/styles\.css\?v=[0-9a-f]{10}"/, p);
    assert.match(html, /src="\/common\.js\?v=[0-9a-f]{10}"/, p);
  }
  const stamped = await call('GET', '/styles.css?v=abc123');
  assert.match(stamped.headers.get('cache-control'), /immutable/);
  assert.equal((await call('GET', '/styles.css')).headers.get('cache-control'), 'no-cache');
});

test('package order: new packages go last, saving never moves one, and the order is set in one go', async () => {
  const login = await call('POST', '/api/admin/login', { password: 'test-password' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const as = (m, p, b) => call(m, p, b, { Cookie: cookie });
  const created = await as('POST', '/api/admin/packages', { slug: 'mini', name: 'Mini', summary: '', minutes: 20, photos: 5, turnaround_days: 3, price_cents: 9000, deposit_cents: 3000, active: true });
  const slugs = async () => (await call('GET', '/api/packages')).data.packages.map((p) => p.slug);
  assert.equal((await slugs()).at(-1), 'mini', 'a new package goes last');
  const ids = (await as('GET', '/api/admin/settings')).data.packages.map((p) => p.id);
  const moved = [created.data.package.id].concat(ids.filter((i) => i !== created.data.package.id));
  assert.equal((await as('PUT', '/api/admin/packages/order', { ids: moved })).status, 200);
  assert.equal((await slugs())[0], 'mini', 'moved to the front');
  await as('PUT', `/api/admin/packages/${created.data.package.id}`, { slug: 'mini', name: 'Mini session', summary: '', minutes: 20, photos: 5, turnaround_days: 3, price_cents: 9000, deposit_cents: 3000, active: true });
  assert.equal((await slugs())[0], 'mini', 'saving its details keeps its place');
  assert.equal((await as('PUT', '/api/admin/packages/order', { ids: moved.slice(1) })).status, 400, 'every package, once');
  assert.equal((await call('PUT', '/api/admin/packages/order', { ids: moved })).status, 401);
});

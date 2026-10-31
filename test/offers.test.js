'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server');
const db = require('../src/db');

let server; let base; let cookie;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => server.close());

const call = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
};
const admin = (m, p, b) => call(m, p, b, { Cookie: cookie });
const OFFER = { offer: true, name: 'Golden hour with Maya', slug: 'ignored', summary: 'Your car at Papago at sunset.', minutes: 60, photos: 25, turnaround_days: 7, price_cents: 30000, deposit_cents: 9000, active: true };

test('an offer gets a private link, never shows on the site, and keeps its link when edited', async () => {
  const made = await admin('POST', '/api/admin/packages', OFFER);
  assert.equal(made.status, 200);
  const slug = made.data.package.slug;
  assert.match(slug, /^offer-[0-9a-f]{18}$/, 'the link is made by the server, not typed');
  assert.equal(made.data.package.offer, 1);

  const pub = await call('GET', '/api/packages');
  assert.ok(!pub.data.packages.some((p) => p.slug === slug), 'not on the home page or the booking list');

  const page = await call('GET', '/api/portfolio/' + slug);
  assert.equal(page.status, 200);
  assert.equal(page.data.package.name, 'Golden hour with Maya');
  assert.equal(page.data.package.offer, 1);
  assert.equal((await fetch(`${base}/offer/${slug}`)).status, 200, 'the offer page opens');

  const edited = await admin('PUT', `/api/admin/packages/${made.data.package.id}`, Object.assign({}, OFFER, { price_cents: 32000, slug: 'something-else' }));
  assert.equal(edited.status, 200);
  assert.equal(edited.data.package.slug, slug, 'a sent link keeps working');
  assert.equal(edited.data.package.price_cents, 32000);
});

test('a client books an offer by its link, like any package', async () => {
  const made = await admin('POST', '/api/admin/packages', OFFER);
  const slug = made.data.package.slug;
  const avail = await call('GET', `/api/availability?package=${slug}&days=7`);
  assert.equal(avail.status, 200);
  const slot = avail.data.days.flatMap((d) => d.slots)[0];
  const b = await call('POST', '/api/bookings', { package: slug, slot: slot.key, name: 'Maya Reyes', email: 'maya@example.com', agree: true, method: 'card' },
    { 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(b.status, 200);
  const row = db.get('SELECT b.price_cents, b.deposit_cents, p.offer FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.token = ?', [b.data.token]);
  assert.deepEqual({ ...row }, { price_cents: 30000, deposit_cents: 9000, offer: 1 });
});

test('a closed offer can no longer be booked; ordering the site\'s packages ignores offers', async () => {
  const made = await admin('POST', '/api/admin/packages', Object.assign({}, OFFER, { active: false }));
  assert.equal((await call('GET', '/api/portfolio/' + made.data.package.slug)).status, 404);
  assert.equal((await call('GET', `/api/availability?package=${made.data.package.slug}`)).status, 404);

  const ids = (await call('GET', '/api/packages')).data.packages.map((p) => p.id).reverse();
  const ordered = await admin('PUT', '/api/admin/packages/order', { ids });
  assert.equal(ordered.status, 200, 'the site\'s packages can still be reordered with offers present');
});

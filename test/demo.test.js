'use strict';
// Demo mode, in its own temp folder, without photos (FFMPEG_PATH=none keeps the test fast; the photos use the normal upload code).
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DEMO = '1';
process.env.DEMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-demo-test-'));
process.env.FFMPEG_PATH = 'none';
process.env.RESEND_API_KEY = 're_should_never_be_used';
process.env.STRIPE_SECRET_KEY = 'sk_should_never_be_used';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const config = require('../src/config');
const { createApp } = require('../server');
const db = require('../src/db');
const demo = require('../src/demo');

let server; let base; let cookie;
test.before(async () => {
  server = createApp();
  await demo.prepare();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'demo' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => { server.close(); fs.rmSync(process.env.DEMO_DIR, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, text };
};

test('the demo uses its own database and folders, sends no email and takes no real money', () => {
  assert.ok(config.dbFile.startsWith(process.env.DEMO_DIR), 'its own database, whatever .env says');
  assert.ok(config.galleryDir.startsWith(process.env.DEMO_DIR) && config.mediaDir.startsWith(process.env.DEMO_DIR));
  assert.equal(config.resendApiKey, '', 'no email key, so nothing is ever sent');
  assert.equal(config.stripeSecretKey, '', 'no Stripe key, so the pretend checkout is used');
  assert.equal(config.adminPassword, 'demo');
});

test('there is a booking at every stage, an open offer, and a returning client', async () => {
  const list = (await call('GET', '/api/admin/bookings', null, { Cookie: cookie })).data.bookings;
  const statuses = new Set(list.map((b) => b.status));
  for (const s of ['hold', 'booked', 'prepped', 'shot', 'editing', 'delivered', 'needs_refund', 'cancelled']) assert.ok(statuses.has(s), `has a ${s} booking`);
  assert.ok(list.some((b) => b.pay_method === 'in_person'), 'an in-person booking');
  assert.ok(list.some((b) => b.pay_method === 'zelle' && b.zelle_sent_at), 'a Zelle deposit waiting to be confirmed');
  assert.ok(list.some((b) => b.status === 'delivered' && !b.balance_paid_at), 'a locked gallery');
  assert.ok(list.some((b) => b.status === 'delivered' && b.balance_paid_at), 'a paid gallery');

  const settings = (await call('GET', '/api/admin/settings', null, { Cookie: cookie })).data;
  const offer = settings.packages.find((p) => p.offer);
  assert.ok(offer, 'an open offer');
  assert.equal((await call('GET', '/api/portfolio/' + offer.slug)).status, 200);

  const clients = (await call('GET', '/api/admin/clients', null, { Cookie: cookie })).data.clients;
  const ezra = clients.find((c) => c.email === 'ezra@demo.example');
  assert.ok(ezra.repeat && ezra.notes, 'a returning client with notes');

  const pay = (await call('GET', '/api/admin/payments', null, { Cookie: cookie })).data.methods;
  assert.deepEqual({ ...pay }, { card: true, zelle: true, inPerson: true }, 'every way to pay is on');
});

test('a visitor can book in the demo with the pretend checkout; every page says it is a demo', async () => {
  const slot = (await call('GET', '/api/availability?package=portrait&days=40')).data.days.flatMap((d) => d.slots)[0].key;
  const b = await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Demo Visitor', email: 'visitor@demo.example', agree: true, method: 'card' }, { 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(b.status, 200);
  assert.match(b.data.checkoutUrl, /^\/api\/dev\/pay\//, 'pretend checkout, never Stripe');
  for (const p of ['/', '/book', '/admin']) assert.match((await call('GET', p)).text, /class="demo-banner"/, `${p} shows the demo note`);
  assert.equal((await call('GET', '/api/site')).data.demo, true);
});

test('Reset puts the sample data back as it started', async () => {
  const before = db.get('SELECT COUNT(*) n FROM bookings').n;
  db.run("UPDATE packages SET name = 'Changed by a visitor' WHERE slug = 'portrait'");
  assert.equal((await call('POST', '/api/admin/demo/reset', {})).status, 401, 'only the logged-in admin can reset');
  const r = await call('POST', '/api/admin/demo/reset', {}, { Cookie: cookie });
  assert.equal(r.status, 200);
  assert.equal(db.get("SELECT name FROM packages WHERE slug = 'portrait'").name, 'Portrait');
  assert.ok(db.get('SELECT COUNT(*) n FROM bookings').n <= before, 'the visitor\'s booking is gone');
  assert.equal(db.get("SELECT COUNT(*) n FROM bookings WHERE client_email = 'visitor@demo.example'").n, 0);
});

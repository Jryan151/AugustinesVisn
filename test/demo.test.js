'use strict';
// The Demo switch, on the same site: sample data for the photographer's browser only. No photos here (FFMPEG_PATH=none
// keeps the test fast; the demo's photos go through the normal upload code).
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.DEMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-demo-test-'));
process.env.FFMPEG_PATH = 'none';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server');
const db = require('../src/db');
const mail = require('../src/mail');

let server; let base; let admin; let demo;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  admin = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => { server.close(); fs.rmSync(process.env.DEMO_DIR, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, text, headers: r.headers };
};
const realBookings = () => db.get('SELECT COUNT(*) n FROM bookings').n; // outside any request: always the real database

test('only the logged-in photographer can switch the demo on', async () => {
  assert.equal((await call('POST', '/api/admin/demo', { on: true })).status, 401);
  // A visitor who sets the cookie by hand still gets the real site.
  const forged = await call('GET', '/api/site', null, { Cookie: 'av_demo=1' });
  assert.equal(forged.data.demo, false);

  const on = await call('POST', '/api/admin/demo', { on: true }, { Cookie: admin });
  assert.equal(on.status, 200);
  assert.match(on.headers.get('set-cookie'), /av_demo=1; Path=\/; HttpOnly; SameSite=Strict/);
  demo = `${admin}; av_demo=1`;
  assert.equal((await call('GET', '/api/admin/me', null, { Cookie: demo })).data.demo, true);
});

test('in the demo: a booking at every stage, an offer, a returning client; the real site is untouched', async () => {
  const list = (await call('GET', '/api/admin/bookings', null, { Cookie: demo })).data.bookings;
  const statuses = new Set(list.map((b) => b.status));
  for (const s of ['hold', 'booked', 'prepped', 'shot', 'editing', 'delivered', 'needs_refund', 'cancelled']) assert.ok(statuses.has(s), `has a ${s} booking`);
  assert.ok(list.some((b) => b.pay_method === 'in_person'));
  assert.ok((await call('GET', '/api/admin/settings', null, { Cookie: demo })).data.packages.some((p) => p.offer), 'an offer');
  assert.ok((await call('GET', '/api/admin/clients', null, { Cookie: demo })).data.clients.some((c) => c.repeat && c.notes), 'a returning client');

  assert.equal(realBookings(), 0, 'the real database has none of it');
  assert.equal((await call('GET', '/api/admin/bookings', null, { Cookie: admin })).data.bookings.length, 0, 'the photographer without the switch sees the real board');
  assert.equal((await call('GET', '/api/packages')).data.packages.some((p) => p.offer), false);
  assert.match((await call('GET', '/', null, { Cookie: demo })).text, /class="demo-banner"/, 'demo pages say so');
  assert.doesNotMatch((await call('GET', '/')).text, /class="demo-banner"/, 'real pages don\'t');
});

test('the demo sends no email and takes no real money', async () => {
  const before = mail.sentInTests.length;
  const slot = (await call('GET', '/api/availability?package=portrait&days=40', null, { Cookie: demo })).data.days.flatMap((d) => d.slots)[0].key;
  const b = await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Demo Visitor', email: 'visitor@demo.example', agree: true, method: 'in_person' },
    { Cookie: demo, 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(b.status, 200, 'the in-person code step works in the demo');
  const card = await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Demo Card', email: 'card@demo.example', agree: true, method: 'card' },
    { Cookie: demo, 'Idempotency-Key': crypto.randomUUID() });
  assert.match(card.data.checkoutUrl, /^\/api\/dev\/pay\//, 'pretend checkout, never Stripe');
  await mail.processOutbox();
  assert.equal(mail.sentInTests.length, before, 'no email left the demo');
  assert.equal(realBookings(), 0);
});

test('Reset works only inside the demo; switching off returns to the real site', async () => {
  assert.equal((await call('POST', '/api/admin/demo/reset', {}, { Cookie: admin })).status, 400, 'never from the real site');
  assert.equal((await call('POST', '/api/admin/demo/reset', {}, { Cookie: demo })).status, 200);
  const list = (await call('GET', '/api/admin/bookings', null, { Cookie: demo })).data.bookings;
  assert.ok(!list.some((b) => b.client_email === 'card@demo.example'), 'changes made in the demo are gone');

  const off = await call('POST', '/api/admin/demo', { on: false }, { Cookie: demo });
  assert.match(off.headers.get('set-cookie'), /av_demo=; .*Max-Age=0/);
  assert.equal((await call('GET', '/api/admin/me', null, { Cookie: admin })).data.demo, false);
});

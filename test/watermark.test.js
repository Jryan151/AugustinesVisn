'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'av-wm-'));
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GALLERY_DIR = path.join(TMP, 'galleries');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createApp } = require('../server');
const db = require('../src/db');
const media = require('../src/media');
const mail = require('../src/mail');

let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-hide_banner', '-version']); } catch (e) { haveFfmpeg = false; }
const skip = haveFfmpeg ? false : 'ffmpeg isn’t installed here';

let server; let base; let cookie; let photoJpg;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
  const r = await fetch(base + '/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'test-password' }), headers: { 'Content-Type': 'application/json' } });
  cookie = r.headers.get('set-cookie').split(';')[0];
  if (haveFfmpeg) {
    const f = path.join(TMP, 'shot.jpg');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=1200x800', '-frames:v', '1', f]);
    photoJpg = fs.readFileSync(f);
  }
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(base + p, { method, redirect: 'manual', headers: Object.assign(isBuf ? {} : { 'Content-Type': 'application/json' }, headers), body: body == null ? undefined : isBuf ? body : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch (e) { data = buf; }
  return { status: r.status, data, headers: r.headers };
};
const admin = (m, p, b, h = {}) => call(m, p, b, Object.assign({ Cookie: cookie }, h));
let slotN = 0;
async function deliveredClient() {
  const av = await call('GET', '/api/availability?package=portrait&days=60');
  const slot = av.data.days.flatMap((d) => d.slots)[slotN++].key;
  const b = await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Wynn Mark', email: `w${slotN}@example.com`, agree: true }, { 'Idempotency-Key': crypto.randomUUID() });
  await call('GET', b.data.checkoutUrl);
  const row = db.get('SELECT * FROM bookings WHERE token = ?', [b.data.token]);
  const up = await admin('PUT', `/api/admin/bookings/${row.id}/photos`, photoJpg, { 'X-File-Name': 'shot.jpg' });
  await admin('POST', `/api/admin/bookings/${row.id}/deliver`, {});
  return { b: db.get('SELECT * FROM bookings WHERE id = ?', [row.id]), photo: up.data.photo };
}
const pixel = (jpg, x, y) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: jpg });

test('before the balance: the client sees the brand mark across the photo, at the right size, never the clean one', { skip }, async () => {
  const { b, photo } = await deliveredClient();
  const proof = await call('GET', `/g/${b.token}/${photo.id}/web`);
  assert.equal(proof.status, 200);
  assert.equal(media.sniff(proof.data), 'jpg');
  const clean = await admin('GET', `/api/admin/photos/${photo.id}/web`);
  assert.ok(!proof.data.equals(clean.data), 'the proof is not the clean photo');
  // The centre of the plain blue test photo turns lighter where the white mark is drawn.
  const centreClean = pixel(clean.data, 600, 400); const corner = pixel(proof.data, 20, 20);
  const strip = Array.from({ length: 40 }, (_, i) => pixel(proof.data, 300 + i * 15, 400)).map((p) => p[0] + p[1] + p[2]);
  assert.ok(Math.max(...strip) > centreClean[0] + centreClean[1] + centreClean[2] + 60, 'the mark shows across the middle');
  assert.ok(Math.abs(corner[2] - centreClean[2]) < 30, 'the corner is untouched');
  const thumb = await call('GET', `/g/${b.token}/${photo.id}/thumb`);
  assert.equal(thumb.status, 200);
  assert.equal((await call('GET', `/g/${b.token}/${photo.id}/original`)).status, 402);
});

test('paying the balance online in the gallery unlocks the clean photos and emails the client once', { skip }, async () => {
  const { b, photo } = await deliveredClient();
  const k = crypto.randomUUID();
  const pay = await call('POST', `/api/gallery/${b.token}/pay`, {}, { 'Idempotency-Key': k });
  assert.match(pay.data.checkoutUrl, /^\/api\/dev\/pay-balance\//);
  assert.deepEqual((await call('POST', `/api/gallery/${b.token}/pay`, {}, { 'Idempotency-Key': k })).data, pay.data, 'a double tap gets the same checkout');
  await call('GET', pay.data.checkoutUrl);
  const g = await call('GET', '/api/gallery/' + b.token);
  assert.equal(g.data.locked, false);
  const orig = await call('GET', `/g/${b.token}/${photo.id}/original`);
  assert.ok(orig.data.equals(photoJpg), 'the clean original, exactly as uploaded');
  mail.sentInTests.length = 0;
  await mail.processOutbox(new Date(Date.now() + 20000));
  assert.equal(mail.sentInTests.filter((m) => m.kind === 'unlocked').length, 1);
  assert.equal((await call('POST', `/api/gallery/${b.token}/pay`, {}, { 'Idempotency-Key': crypto.randomUUID() })).data.paid, true);
});

test('Stripe’s webhook for a balance unlocks; a photographer’s mark can be undone before the email leaves', { skip }, async () => {
  const one = await deliveredClient();
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_bal', payment_status: 'paid', client_reference_id: one.b.token, metadata: { kind: 'balance' } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${event}`).digest('hex');
  await fetch(base + '/api/stripe/webhook', { method: 'POST', body: event, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` } });
  const row = db.get('SELECT status, balance_paid_by, balance_session_id FROM bookings WHERE id = ?', [one.b.id]);
  assert.deepEqual({ ...row }, { status: 'delivered', balance_paid_by: 'online', balance_session_id: 'cs_bal' }, 'a balance payment never touches the booking itself');

  const two = await deliveredClient();
  await admin('POST', `/api/admin/bookings/${two.b.id}/balance-paid`, {});
  const u = await admin('POST', `/api/admin/bookings/${two.b.id}/undo`, { action: 'balance', previous: 'delivered' });
  assert.equal(u.data.booking.balance_paid_at, null);
  assert.equal((await call('GET', '/api/gallery/' + two.b.token)).data.locked, true);
  assert.equal((await admin('POST', `/api/admin/bookings/${one.b.id}/undo`, { action: 'balance', previous: 'delivered' })).status, 400, 'an online payment can’t be undone here');
});

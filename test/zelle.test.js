'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.SESSION_SECRET = 'test-secret';
process.env.FFMPEG_PATH = 'none';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'av-zelle-'));
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GALLERY_DIR = path.join(TMP, 'galleries');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server');
const db = require('../src/db');
const mail = require('../src/mail');

const JPG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAGAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCtAR06f//Z', 'base64');

let server; let base; let cookie;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
  const r = await fetch(base + '/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'test-password' }), headers: { 'Content-Type': 'application/json' } });
  cookie = r.headers.get('set-cookie').split(';')[0];
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
const row = (token) => db.get('SELECT * FROM bookings WHERE token = ?', [token]);
const outbox = (id, kind) => db.get("SELECT * FROM outbox WHERE booking_id = ? AND kind = ? AND status != 'cancelled'", [id, kind]);
let slotN = 0;
async function zelleBooking(over = {}) {
  const av = await call('GET', '/api/availability?package=portrait&days=60');
  const slot = av.data.days.flatMap((d) => d.slots)[slotN++].key;
  const r = await call('POST', '/api/bookings', Object.assign({ package: 'portrait', slot, name: 'Zoe Elle', email: `z${slotN}@example.com`, agree: true, method: 'zelle' }, over), { 'Idempotency-Key': crypto.randomUUID() });
  return r;
}
const codeFrom = (body) => /\/confirm\/([^\s]+)/.exec(body)[1];

test('Zelle settings: needs a real recipient before it can be turned on; only then offered to clients', async () => {
  assert.equal((await call('GET', '/api/site')).data.payments.zelle, false);
  assert.equal((await admin('PUT', '/api/admin/payments', { zelle: { enabled: true, recipient: '' } })).status, 400);
  assert.equal((await admin('PUT', '/api/admin/payments', { zelle: { enabled: true, recipient: 'not a contact' } })).status, 400);
  assert.equal((await call('PUT', '/api/admin/payments', { zelle: { enabled: true, recipient: 'pay@augustines.example' } })).status, 401);
  const ok = await admin('PUT', '/api/admin/payments', { zelle: { enabled: true, recipient: 'pay@augustines.example', name: 'Augustine V', holdHours: 24 } });
  assert.equal(ok.status, 200);
  const site = (await call('GET', '/api/site')).data;
  assert.equal(site.payments.zelle, true);
  assert.equal(site.zelle.recipient, 'pay@augustines.example');
});

test('booking by Zelle: held 24 hours with a memo reference, and the client is emailed exactly where to send it', async () => {
  const r = await zelleBooking();
  assert.equal(r.status, 200);
  assert.match(r.data.checkoutUrl, /^\/booked\?b=/, 'no checkout: straight to their booking page');
  const b = row(r.data.token);
  assert.equal(b.status, 'hold'); assert.equal(b.pay_method, 'zelle');
  assert.match(b.ref_code, /^AV-[A-HJ-NP-Z2-9]{4}$/);
  const hours = (new Date(b.hold_expires_at) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24, `held ${hours} hours`);
  const email = outbox(b.id, 'zelle_deposit');
  assert.equal(email.to_addr, b.client_email);
  assert.match(email.body, /pay@augustines\.example/); assert.match(email.body, new RegExp(b.ref_code)); assert.match(email.body, /\$25/);
  const view = (await call('GET', '/api/bookings/' + r.data.token)).data;
  assert.equal(view.status, 'hold'); assert.equal(view.ref, b.ref_code); assert.equal(view.zelle.recipient, 'pay@augustines.example');
  const board = (await admin('GET', '/api/admin/bookings')).data.bookings;
  assert.ok(board.some((x) => x.id === b.id && x.status === 'hold'), 'shown on the board as waiting for Zelle');
});

test('"I’ve sent it": keeps the time for 48 hours and emails the photographer a signed one-tap Confirm (once)', async () => {
  const r = await zelleBooking();
  await call('POST', `/api/bookings/${r.data.token}/zelle-sent`, {});
  await call('POST', `/api/bookings/${r.data.token}/zelle-sent`, {});
  const b = row(r.data.token);
  assert.ok(b.zelle_sent_at);
  assert.ok(new Date(b.hold_expires_at) - Date.now() > 47.9 * 3600000);
  assert.equal(db.get("SELECT COUNT(*) n FROM outbox WHERE booking_id = ? AND kind = 'admin_zelle_deposit'", [b.id]).n, 1);
  const email = outbox(b.id, 'admin_zelle_deposit');
  assert.equal(email.to_addr, 'me@example.com');
  assert.match(email.subject, new RegExp(b.ref_code));
  const code = codeFrom(email.body);
  const d = (await call('GET', '/api/confirm/' + code)).data;
  assert.deepEqual([d.what, d.done, d.amountCents, d.ref], ['deposit', false, 2500, b.ref_code]);
  const forged = code.replace(/\.[^.]+$/, '.' + 'x'.repeat(32));
  assert.equal((await call('POST', '/api/confirm/' + forged, {})).status, 404, 'a changed link does nothing');
  const other = code.replace(/^\d+/, String(b.id + 1));
  assert.equal((await call('POST', '/api/confirm/' + other, {})).status, 404, 'can’t point it at another booking');
});

test('Confirm from the email: booked, client emailed after 10 s (Undo works until then), no extra notice to the photographer', async () => {
  const r = await zelleBooking();
  await call('POST', `/api/bookings/${r.data.token}/zelle-sent`, {});
  const b = row(r.data.token);
  const code = codeFrom(outbox(b.id, 'admin_zelle_deposit').body);
  const done = await call('POST', '/api/confirm/' + code, {});
  assert.equal(done.data.done, true);
  assert.equal(row(r.data.token).status, 'booked');
  const conf = outbox(b.id, 'confirmation');
  assert.ok(new Date(conf.send_after) - Date.now() > 5000, 'the confirmation waits for Undo');
  assert.equal(outbox(b.id, 'admin_new'), undefined, 'the photographer confirmed it, so no "new booking" email');
  const undone = await call('POST', `/api/confirm/${code}/undo`, {});
  assert.equal(undone.data.done, false);
  assert.equal(row(r.data.token).status, 'hold');
  assert.equal(outbox(b.id, 'confirmation'), undefined, 'the confirmation never left');
  await call('POST', '/api/confirm/' + code, {});
  mail.sentInTests.length = 0;
  await mail.processOutbox(new Date(Date.now() + 20000));
  assert.ok(mail.sentInTests.some((m) => m.kind === 'confirmation' && m.to_addr === b.client_email));
  assert.equal((await call('POST', `/api/confirm/${code}/undo`, {})).status, 409, 'too late once they’ve been told');
  assert.equal((await call('GET', '/api/confirm/' + code)).data.done, true);
});

test('Confirm from Admin, release from Admin, and a late confirm never double-books', async () => {
  const a = await zelleBooking();
  const ida = row(a.data.token).id;
  const got = await admin('POST', `/api/admin/bookings/${ida}/zelle-received`, {});
  assert.equal(got.data.booking.status, 'booked');
  const u = await admin('POST', `/api/admin/bookings/${ida}/undo`, { action: 'zelle', previous: 'booked' });
  assert.equal(u.data.booking.status, 'hold');

  const b = await zelleBooking();
  const idb = row(b.data.token).id;
  assert.equal((await admin('POST', `/api/admin/bookings/${idb}/cancel`, {})).data.booking.status, 'cancelled');
  assert.equal(outbox(idb, 'cancelled'), undefined, 'releasing a hold emails nobody');

  // A hold that ran out, its time taken by someone else, then the Zelle confirmed late: flagged for a refund.
  const c = await zelleBooking();
  const cr = row(c.data.token);
  db.run("UPDATE bookings SET hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [cr.id]);
  const taker = await call('POST', '/api/bookings', { package: 'portrait', slot: cr.slot_key, name: 'Other', email: 'o@example.com', agree: true, method: 'zelle' }, { 'Idempotency-Key': crypto.randomUUID() });
  assert.equal(taker.status, 200, 'the time was free again');
  const code = require('../src/zelle').confirmCode(cr.id, 'deposit');
  const late = await call('POST', '/api/confirm/' + code, {});
  assert.equal(late.data.needsRefund, true);
  assert.equal(row(c.data.token).status, 'needs_refund');
  assert.equal(row(taker.data.token).status, 'hold');
});

test('Zelle for the balance: the gallery shows it, "sent" emails the photographer, Confirm unlocks the photos', async () => {
  const r = await call('POST', '/api/bookings', { package: 'portrait', slot: (await call('GET', '/api/availability?package=portrait&days=60')).data.days.flatMap((d) => d.slots)[slotN++].key, name: 'Bal Ance', email: 'bal@example.com', agree: true, method: 'card' }, { 'Idempotency-Key': crypto.randomUUID() });
  await call('GET', r.data.checkoutUrl);
  const b = row(r.data.token);
  await admin('PUT', `/api/admin/bookings/${b.id}/photos`, JPG, { 'X-File-Name': 'a.jpg' });
  await admin('POST', `/api/admin/bookings/${b.id}/deliver`, {});
  const g = (await call('GET', '/api/gallery/' + b.token)).data;
  assert.equal(g.locked, true); assert.equal(g.zelle.recipient, 'pay@augustines.example'); assert.match(g.ref, /^AV-/);
  await call('POST', `/api/gallery/${b.token}/zelle-sent`, {});
  const email = outbox(b.id, 'admin_zelle_balance');
  assert.match(email.body, /\$50/);
  const code = codeFrom(email.body);
  assert.match(code, /\.balance\./);
  await call('POST', '/api/confirm/' + code, {});
  assert.equal((await call('GET', '/api/gallery/' + b.token)).data.locked, false);
  assert.equal(row(b.token).balance_paid_by, 'zelle');
  assert.ok(new Date(outbox(b.id, 'unlocked').send_after) - Date.now() > 5000, 'the unlock email waits for Undo');
});

test('an expired Confirm link is refused, and so is one signed with another secret', () => {
  const z = require('../src/zelle');
  const old = z.confirmCode(1, 'deposit', Date.now() - 15 * 86400000);
  assert.throws(() => z.readCode(old), /expired/);
  const [id, what, exp] = z.confirmCode(1, 'deposit').split('.');
  const foreign = crypto.createHmac('sha256', 'other').update(`zelle:${id}.${what}.${exp}`).digest('base64url').slice(0, 32);
  assert.throws(() => z.readCode(`${id}.${what}.${exp}.${foreign}`), /isn.t right/);
});

test('portfolio: photographer adds, reorders and removes; visitors see it on the package page', async () => {
  const pkg = db.get("SELECT id FROM packages WHERE slug = 'automotive'");
  assert.equal((await call('PUT', `/api/admin/packages/${pkg.id}/portfolio`, JPG)).status, 401);
  await admin('PUT', `/api/admin/packages/${pkg.id}/portfolio`, JPG);
  const two = (await admin('PUT', `/api/admin/packages/${pkg.id}/portfolio`, JPG)).data.photos;
  assert.equal(two.length, 2);
  const list = (await call('GET', '/api/packages')).data.packages.find((p) => p.slug === 'automotive');
  assert.equal(list.portfolio_count, 2);
  const firsted = (await admin('POST', `/api/admin/portfolio/${two[1].id}/first`, {})).data.photos;
  assert.equal(firsted[0].id, two[1].id);
  const page = await call('GET', '/api/portfolio/automotive');
  assert.equal(page.data.photos.length, 2); assert.equal(page.data.package.name, 'Car');
  assert.equal((await call('GET', page.data.photos[0].web)).status, 200);
  await admin('DELETE', `/api/admin/portfolio/${two[0].id}`);
  assert.equal((await call('GET', two[0].web)).status, 404, 'the file is gone too');
  assert.equal((await call('GET', '/api/portfolio/nope')).status, 404);
  const html = (await call('GET', '/portfolio/automotive')).data.toString();
  assert.match(html, /portfolio\.js\?v=/);
});

test('email: status for Admin, and a test email goes to the photographer', async () => {
  const s = (await admin('GET', '/api/admin/email')).data;
  assert.equal(s.adminEmail, 'me@example.com'); assert.equal(s.resend, false);
  mail.sentInTests.length = 0;
  const t = await admin('POST', '/api/admin/email/test', {});
  assert.equal(t.data.sent, true);
  assert.ok(mail.sentInTests.some((m) => m.kind === 'test' && m.to_addr === 'me@example.com'));
});

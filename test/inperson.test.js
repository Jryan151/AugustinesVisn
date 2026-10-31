'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../server');
const db = require('../src/db');
const mail = require('../src/mail');
const bookings = require('../src/bookings');

let server; let base; let cookie;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { morning: [0, 1, 2, 3, 4, 5, 6], evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
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
let n = 0;
async function freeSlot() {
  const a = await call('GET', '/api/availability?package=portrait&days=30');
  return a.data.days.flatMap((d) => d.slots)[n++].key;
}
const ask = (slot, email, extra = {}) => call('POST', '/api/bookings', Object.assign({ package: 'portrait', slot, name: 'Ana Cruz', email, agree: true, method: 'in_person' }, extra), { 'Idempotency-Key': crypto.randomUUID() });
// The code as emailed (tests read it from the outbox, like the client reads their inbox).
const codeFor = (email) => /(\d{6}) is your booking code/.exec(db.get("SELECT subject FROM outbox WHERE kind = 'booking_code' AND to_addr = ? ORDER BY id DESC LIMIT 1", [email]).subject)[1];
const liveOn = (slot) => db.get("SELECT COUNT(*) n FROM bookings WHERE slot_key = ? AND status NOT IN ('cancelled','expired','needs_refund')", [slot]).n;

test('asking for a code holds nothing; the right code books the time with the whole price due in person', async () => {
  const slot = await freeSlot();
  const asked = await ask(slot, 'ana@example.com');
  assert.equal(asked.status, 200);
  assert.ok(asked.data.verify);
  assert.equal(asked.data.email, 'a•••@example.com', 'the email is shown masked');
  assert.equal(liveOn(slot), 0, 'no time is held before the code is typed');
  assert.ok((await call('GET', '/api/availability?package=portrait&days=30')).data.days.flatMap((d) => d.slots).some((s) => s.key === slot), 'still bookable by others');

  const ok = await call('POST', '/api/bookings/verify', { verify: asked.data.verify, code: codeFor('ana@example.com') });
  assert.equal(ok.status, 200);
  const b = bookings.byToken(ok.data.token);
  assert.equal(b.status, 'booked');
  assert.equal(b.pay_method, 'in_person');
  assert.equal(b.deposit_cents, 0, 'nothing paid online');
  assert.equal(liveOn(slot), 1);
  assert.equal(bookings.isUnlocked(b), false, 'photos stay locked until paid in person');
  const confirm = db.get("SELECT body FROM outbox WHERE kind = 'confirmation' AND booking_id = ?", [b.id]).body;
  assert.match(confirm, /in person, at the shoot/);

  const again = await call('POST', '/api/bookings/verify', { verify: asked.data.verify, code: codeFor('ana@example.com') });
  assert.equal(again.data.token, ok.data.token, 'the same code twice gives the same booking, never a second one');
  assert.equal(liveOn(slot), 1);

  // Paid at the shoot: the photographer marks it paid, and the photos unlock.
  const paid = await call('POST', `/api/admin/bookings/${b.id}/balance-paid`, {}, { Cookie: cookie });
  assert.equal(paid.status, 200);
  assert.equal(bookings.isUnlocked(bookings.byId(b.id)), true);
});

test('wrong codes are refused and limited; an expired code books nothing', async () => {
  const slot = await freeSlot();
  const asked = await ask(slot, 'ben@example.com');
  const right = codeFor('ben@example.com');
  const wrong = right === '000000' ? '111111' : '000000';
  const first = await call('POST', '/api/bookings/verify', { verify: asked.data.verify, code: wrong });
  assert.equal(first.status, 400);
  assert.match(first.data.error, /4 tries left/);
  for (let i = 0; i < 4; i++) await call('POST', '/api/bookings/verify', { verify: asked.data.verify, code: wrong });
  const locked = await call('POST', '/api/bookings/verify', { verify: asked.data.verify, code: right });
  assert.equal(locked.status, 429, 'after 5 wrong tries even the right code is refused');
  assert.equal(liveOn(slot), 0);

  const asked2 = await ask(slot, 'cal@example.com');
  db.run('UPDATE email_checks SET expires_at = ? WHERE token = ?', [new Date(Date.now() - 1000).toISOString(), asked2.data.verify]);
  const late = await call('POST', '/api/bookings/verify', { verify: asked2.data.verify, code: codeFor('cal@example.com') });
  assert.equal(late.status, 410);
  assert.equal(liveOn(slot), 0);
});

test('one email can ask for 3 codes in half an hour; a time taken meanwhile is refused cleanly', async () => {
  const slot = await freeSlot();
  for (let i = 0; i < 3; i++) assert.equal((await ask(slot, 'dee@example.com')).status, 200);
  const fourth = await ask(slot, 'dee@example.com');
  assert.equal(fourth.status, 429);

  // Two people ask for the same time; the first to type their code gets it.
  const slot2 = await freeSlot();
  const a = await ask(slot2, 'eve@example.com');
  const b = await ask(slot2, 'fay@example.com');
  assert.equal((await call('POST', '/api/bookings/verify', { verify: a.data.verify, code: codeFor('eve@example.com') })).status, 200);
  const lost = await call('POST', '/api/bookings/verify', { verify: b.data.verify, code: codeFor('fay@example.com') });
  assert.equal(lost.status, 409);
  assert.equal(lost.data.code, 'slot_taken');
  assert.equal(liveOn(slot2), 1, 'never double-booked');
});

test('the photographer can turn in person off', async () => {
  const off = await call('PUT', '/api/admin/payments', { inPerson: { enabled: false } }, { Cookie: cookie });
  assert.equal(off.data.methods.inPerson, false);
  const slot = await freeSlot();
  assert.equal((await ask(slot, 'gus@example.com')).status, 503);
  await call('PUT', '/api/admin/payments', { inPerson: { enabled: true } }, { Cookie: cookie });
  assert.equal(mail.sentInTests.filter((m) => m.kind === 'booking_code').length >= 1, true, 'codes go out through the outbox straight away');
});

'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const db = require('../src/db');
const availability = require('../src/availability');
const requests = require('../src/requests');

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
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const admin = (m, p, b) => call(m, p, b, { Cookie: cookie });
const inDays = (n) => availability.addDays(availability.localDate(new Date()), n);
const ask = (date, time, email = 'lena@example.com') => call('POST', '/api/requests', { package: 'portrait', date, time, name: 'Lena Ortiz', email, note: 'Lunch break' });

test('a request holds nothing; the photographer is emailed and sees it on the board', async () => {
  const r = await ask(inDays(5), '12:30');
  assert.equal(r.status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM bookings').n, 0, 'nothing booked or held');
  assert.ok(db.get("SELECT 1 FROM outbox WHERE kind = 'admin_time_request' AND to_addr = 'me@example.com'"));
  const board = (await admin('GET', '/api/admin/bookings')).data;
  assert.equal(board.requests.length, 1);
  assert.match(board.requests[0].when, /12:30 PM/);
});

test('Book it makes an in-person booking at that time (or a changed one) and emails after the Undo wait', async () => {
  const id = (await admin('GET', '/api/admin/bookings')).data.requests[0].id;
  const ok = await admin('POST', `/api/admin/requests/${id}/approve`, { time: '13:00' });
  assert.equal(ok.status, 200);
  const b = ok.data.booking;
  assert.equal(b.status, 'booked'); assert.equal(b.pay_method, 'in_person'); assert.equal(b.deposit_cents, 0);
  assert.equal(b.start_at, requests.localToUtc(inDays(5), '13:00').toISOString(), 'at the time he set, in Phoenix time');
  const mail = db.get("SELECT send_after FROM outbox WHERE booking_id = ? AND kind = 'confirmation'", [b.id]);
  assert.ok(Date.parse(mail.send_after) > Date.now() + 5000, 'the confirmation waits, so Undo can take it back');
  assert.equal((await admin('GET', '/api/admin/bookings')).data.requests.length, 0, 'answered: off the requests list');

  // Undo: the booking and its email are gone, the request is waiting again.
  assert.equal((await admin('POST', `/api/admin/requests/${id}/undo`, {})).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM bookings WHERE id = ?', [b.id]).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM outbox WHERE booking_id = ? AND status != 'cancelled'", [b.id]).n, 0);
  assert.equal((await admin('GET', '/api/admin/bookings')).data.requests.length, 1);
});

test('never double-booked: a custom time hides the golden-hour slot it overlaps, and a clash is refused', async () => {
  const date = inDays(8);
  const sunset = (await call('GET', `/api/availability?package=portrait&from=${date}&days=1`)).data.days[0].slots.find((s) => s.period === 'evening');
  assert.ok(sunset, 'the sunset slot is open first');
  // Someone asks for a time inside that sunset session, and it's booked.
  const local = new Date(sunset.start).toLocaleTimeString('en-GB', { timeZone: 'America/Phoenix', hour: '2-digit', minute: '2-digit' });
  await ask(date, local, 'sam@example.com');
  const id = (await admin('GET', '/api/admin/bookings')).data.requests.find((r) => r.client_email === 'sam@example.com').id;
  assert.equal((await admin('POST', `/api/admin/requests/${id}/approve`, {})).status, 200);
  const after = (await call('GET', `/api/availability?package=portrait&from=${date}&days=1`)).data.days[0].slots;
  assert.ok(!after.some((s) => s.period === 'evening'), 'the overlapping sunset slot is no longer offered');

  // A second request at the same moment can't be booked on top of it.
  await ask(date, local, 'kim@example.com');
  const id2 = (await admin('GET', '/api/admin/bookings')).data.requests.find((r) => r.client_email === 'kim@example.com').id;
  const clash = await admin('POST', `/api/admin/requests/${id2}/approve`, {});
  assert.equal(clash.status, 409);
});

test('Decline emails the client after the wait (Undo can stop it); bad requests and floods are refused', async () => {
  const id = (await admin('GET', '/api/admin/bookings')).data.requests.find((r) => r.client_email === 'kim@example.com').id;
  assert.equal((await admin('POST', `/api/admin/requests/${id}/decline`, {})).status, 200);
  const note = db.get("SELECT status, send_after FROM outbox WHERE kind = 'time_request_declined' AND to_addr = 'kim@example.com'");
  assert.ok(Date.parse(note.send_after) > Date.now() + 5000);
  assert.equal((await admin('POST', `/api/admin/requests/${id}/undo`, {})).status, 200);
  assert.equal(db.get("SELECT status FROM outbox WHERE kind = 'time_request_declined' AND to_addr = 'kim@example.com'").status, 'cancelled');

  assert.equal((await ask(inDays(-1), '12:00', 'old@example.com')).status, 400, 'not in the past');
  assert.equal((await ask(inDays(3), '25:00', 'bad@example.com')).status, 400);
  for (let i = 0; i < 2; i++) await ask(inDays(10 + i), '10:00', 'many@example.com');
  assert.equal((await ask(inDays(12), '10:00', 'many@example.com')).status, 200);
  assert.equal((await ask(inDays(13), '10:00', 'many@example.com')).status, 429, '3 a day per email');
  assert.equal((await call('POST', '/api/admin/requests/1/approve', {})).status, 401, 'only the photographer answers');
});

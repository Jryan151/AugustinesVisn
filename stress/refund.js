'use strict';
/* stress/refund.js — once a booking is "needs_refund" (paid after its time went to someone else), can the
   photographer ever clear it off the board? Tries every admin move on one. */
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib');

(async () => {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: { morning: [0, 1, 2, 3, 4, 5, 6], evening: [0, 1, 2, 3, 4, 5, 6], weeklyCap: 50, minNoticeHours: 0, maxDaysAhead: 365 } });
  const slot = (await L.call(s.base, 'GET', '/api/availability?package=portrait&days=10')).data.days.flatMap((d) => d.slots)[0].key;
  const book = (name) => L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() }, body: { package: 'portrait', slot, name, email: name.replace(' ', '') + '@example.test', agree: true, method: 'card' } });
  const late = await book('Late Payer');
  // Their hold runs out, someone else takes the time, then their payment lands.
  const w = new DatabaseSync(s.dbFile); w.prepare("UPDATE bookings SET hold_expires_at = ? WHERE status = 'hold'").run(new Date(Date.now() - 1000).toISOString()); w.close();
  const other = await book('On Time'); await L.call(s.base, 'GET', `/api/dev/pay/${other.data.token}`);
  await L.call(s.base, 'GET', `/api/dev/pay/${late.data.token}`);
  const b = (await L.call(s.base, 'GET', '/api/admin/bookings', { cookie })).data.bookings.find((x) => x.token === late.data.token);
  const tryIt = async (what, body) => { const r = await L.call(s.base, 'POST', `/api/admin/bookings/${b.id}/${what}`, { cookie, body: body || {} }); return { status: r.status, message: r.data.error || 'ok' }; };
  const attempts = {
    cancel: await tryIt('cancel'),
    status_booked: await tryIt('status', { status: 'booked' }),
    status_shot: await tryIt('status', { status: 'shot' }),
    deliver: await tryIt('deliver', { galleryUrl: 'https://example.test/g' }),
    balance_paid: await tryIt('balance-paid'),
  };
  const still = (await L.call(s.base, 'GET', '/api/admin/bookings', { cookie })).data.bookings.find((x) => x.id === b.id);
  const out = { scenario: 'refund', status: b.status, attempts, stillOnBoardAs: still ? still.status : 'gone' };
  s.stop(); L.save('refund', out); console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

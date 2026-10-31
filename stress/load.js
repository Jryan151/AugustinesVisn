'use strict';
/* =====================================================================
   stress/load.js — load scenarios against a throwaway local copy of the site.

   Run one:  node stress/load.js steady|ramp|stampede|retry|churn|zelle|outbox
   Each starts its own server on a temp data folder (see lib.js), prints a summary and writes
   stress/results/<scenario>.json. Email is printed to the server log, never sent. Stripe is off, so the
   development "pay" link stands in for the deposit.
   ===================================================================== */
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib');

// A calendar with room for hundreds of bookings, so throughput is measured rather than the weekly cap.
const OPEN = { morning: [0, 1, 2, 3, 4, 5, 6], evening: [0, 1, 2, 3, 4, 5, 6], weeklyCap: 50, minNoticeHours: 0, maxDaysAhead: 365 };
const PACKAGES = ['portrait', 'couples', 'automotive'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const n = (v) => Math.round(v * 10) / 10;

async function slotsFor(base, pkg, days = 62) {
  const r = await L.call(base, 'GET', `/api/availability?package=${pkg}&days=${days}`);
  return { r, slots: r.status === 200 ? r.data.days.flatMap((d) => d.slots) : [] };
}

/* One client's whole path: look → pick a time → hold → pay (or Zelle) → prep. Retries a taken time twice. */
async function client(base, i, { zelleShare = 0.3, abandonShare = 0.1, log }) {
  const pkg = pick(PACKAGES);
  const rec = (step, r) => { log.push(Object.assign({ step, status: r.status, ms: r.ms })); return r; };
  rec('packages', await L.call(base, 'GET', '/api/packages'));
  const method = Math.random() < zelleShare ? 'zelle' : 'card';
  for (let attempt = 0; attempt < 3; attempt++) {
    const { r, slots } = await slotsFor(base, pkg); rec('availability', r);
    if (!slots.length) return { outcome: 'sold_out' };
    const slot = pick(slots.slice(0, 12)); // people favour the next couple of weeks
    const b = rec('book', await L.call(base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
      body: { package: pkg, slot: slot.key, name: `Client ${i}`, email: `client${i}@example.test`, phone: '555-0100', agree: true, method } }));
    if (b.status === 409) continue;
    if (b.status !== 200) return { outcome: 'error', status: b.status, error: b.data };
    const t = b.data.token;
    if (Math.random() < abandonShare) { rec('release', await L.call(base, 'POST', `/api/bookings/${t}/release`)); return { outcome: 'abandoned' }; }
    if (method === 'zelle') { rec('zelle_sent', await L.call(base, 'POST', `/api/bookings/${t}/zelle-sent`)); return { outcome: 'zelle_waiting', token: t }; }
    rec('pay', await L.call(base, 'GET', `/api/dev/pay/${t}`));
    rec('view', await L.call(base, 'GET', `/api/bookings/${t}`));
    rec('prep', await L.call(base, 'POST', `/api/bookings/${t}/prep`, { body: { location: 'Papago Park', look: 'Warm, candid', who: 'Just me' } }));
    return { outcome: 'booked', token: t, attempts: attempt + 1 };
  }
  return { outcome: 'gave_up_after_3_taken' };
}

function byStep(log) {
  const out = {};
  for (const s of [...new Set(log.map((l) => l.step))]) out[s] = L.stats(log.filter((l) => l.step === s));
  return out;
}

function liveDupes(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  const dup = d.prepare(`SELECT slot_key, COUNT(*) n FROM bookings WHERE status NOT IN ('cancelled','expired','needs_refund') GROUP BY slot_key HAVING n > 1`).all();
  const outboxDup = d.prepare(`SELECT booking_id, kind, COUNT(*) n FROM outbox WHERE booking_id IS NOT NULL AND status != 'cancelled' GROUP BY booking_id, kind HAVING n > 1`).all();
  const counts = d.prepare('SELECT status, COUNT(*) n FROM bookings GROUP BY status').all();
  d.close();
  return { liveDoubleBookings: dup.length, outboxDuplicates: outboxDup.length, bookingsByStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

/* ---------- 1. steady stream ---------- */
async function steady({ seconds = Number(process.env.SECONDS_ || 300), everyMs = Number(process.env.EVERY || 2000), calendar = process.env.CAL || 'real' } = {}) {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: calendar === 'open' ? OPEN : undefined });
  const log = []; const outcomes = []; const running = []; let i = 0; let soldOutAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const id = ++i;
    running.push(client(s.base, id, { log }).then((o) => { outcomes.push(o); if (o.outcome === 'sold_out' && !soldOutAt) soldOutAt = { client: id, afterSeconds: n((Date.now() - t0) / 1000) }; }));
    await L.sleep(everyMs);
  }
  await Promise.all(running);
  const tally = {}; for (const o of outcomes) tally[o.outcome] = (tally[o.outcome] || 0) + 1;
  const out = { scenario: 'steady', calendar, seconds, arrivalEveryMs: everyMs, clients: i, outcomes: tally, firstSoldOut: soldOutAt,
    all: L.stats(log), steps: byStep(log), peakRssMB: n(s.peakRss() / 1048576), files: s.sizes(), checks: liveDupes(s.dbFile) };
  s.stop(); return out;
}

/* ---------- 2. ramp to break ---------- */
async function ramp({ stepSeconds = Number(process.env.STEP || 20), max = Number(process.env.MAX || 256) } = {}) {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: OPEN });
  const levels = [];
  for (let users = 1; users <= max; users *= 2) {
    const log = []; const health = []; let stop = false; s.resetPeak();
    // Event-loop pressure shows up as the cheapest request (health) getting slow.
    const probe = (async () => { while (!stop) { health.push(await L.call(s.base, 'GET', '/api/health')); await L.sleep(100); } })();
    const worker = async (w) => {
      let k = 0;
      while (!stop) {
        const pkg = pick(PACKAGES); const id = `${users}-${w}-${k++}`;
        log.push(Object.assign({ step: 'packages' }, await L.call(s.base, 'GET', '/api/packages')));
        const { r, slots } = await slotsFor(s.base, pkg); log.push(Object.assign({ step: 'availability' }, r));
        if (!slots.length) continue;
        const b = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
          body: { package: pkg, slot: pick(slots).key, name: `Ramp ${id}`, email: `ramp${id}@example.test`, agree: true, method: 'card' } });
        log.push(Object.assign({ step: 'book' }, b));
        if (b.status !== 200) continue;
        log.push(Object.assign({ step: 'view' }, await L.call(s.base, 'GET', `/api/bookings/${b.data.token}`)));
        // Most leave checkout (the time is freed at once), so the calendar never fills and writes keep coming.
        log.push(Object.assign({ step: 'release' }, await L.call(s.base, 'POST', `/api/bookings/${b.data.token}/release`)));
      }
    };
    const t0 = Date.now();
    const ws = Array.from({ length: users }, (_, w) => worker(w));
    await L.sleep(stepSeconds * 1000); stop = true; await Promise.all(ws); await probe;
    const secs = (Date.now() - t0) / 1000;
    const all = L.stats(log);
    const errors = log.filter((l) => l.status >= 500 || l.status === 0).length;
    const lvl = { users, seconds: n(secs), reqPerSec: n(log.length / secs), bookingsPerSec: n(log.filter((l) => l.step === 'book' && l.status === 200).length / secs),
      all, steps: byStep(log), health: L.stats(health), errorRate: n((errors / Math.max(1, log.length)) * 100), peakRssMB: n(s.peakRss() / 1048576), files: s.sizes() };
    levels.push(lvl);
    console.log(`users ${users}: ${lvl.reqPerSec} req/s, p95 ${all.p95} ms, health p95 ${lvl.health.p95} ms, errors ${lvl.errorRate}%, rss ${lvl.peakRssMB} MB`);
    if (all.p95 > 1000 || lvl.errorRate > 1) { lvl.bent = true; break; }
  }
  const out = { scenario: 'ramp', stepSeconds, levels, checks: liveDupes(s.dbFile) };
  s.stop(); return out;
}

/* ---------- 3. slot stampede ---------- */
async function stampede({ clients = 50, rounds = 6 } = {}) {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: OPEN });
  const out = { scenario: 'stampede', clients, rounds: [] };
  for (let r = 0; r < rounds; r++) {
    const method = r % 2 ? 'zelle' : 'card';
    const { slots } = await slotsFor(s.base, 'portrait');
    const slot = slots[r].key;
    const res = await Promise.all(Array.from({ length: clients }, (_, i) => L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
      body: { package: pick(PACKAGES), slot, name: `Rush ${r}-${i}`, email: `rush${r}-${i}@example.test`, agree: true, method } })));
    const tally = {}; for (const x of res) tally[x.status] = (tally[x.status] || 0) + 1;
    const messages = [...new Set(res.filter((x) => x.status !== 200).map((x) => x.data.error))];
    const codes = [...new Set(res.filter((x) => x.status !== 200).map((x) => x.data.code))];
    out.rounds.push({ slot, method, byStatus: tally, losers: { messages, codes }, latency: L.stats(res) });
  }
  out.checks = liveDupes(s.dbFile);
  s.stop(); return out;
}

/* ---------- 4. double-tap / retry storm ---------- */
async function retry() {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: OPEN });
  const out = { scenario: 'retry', cases: [] };
  for (const method of ['card', 'zelle']) {
    const { slots } = await slotsFor(s.base, 'couples');
    const k = L.key(); const email = `tap-${method}@example.test`;
    const body = { package: 'couples', slot: slots[method === 'card' ? 0 : 1].key, name: 'Double Tap', email, agree: true, method };
    const burst = await Promise.all(Array.from({ length: 20 }, () => L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': k }, body })));
    const after = await Promise.all(Array.from({ length: 5 }, () => L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': k }, body })));
    // The same key with a different time: a client who goes back and changes their pick but whose browser kept the key.
    const changed = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': k }, body: Object.assign({}, body, { slot: slots[5].key }) });
    const d = new DatabaseSync(s.dbFile, { readOnly: true });
    const rows = d.prepare('SELECT COUNT(*) n FROM bookings WHERE client_email = ?').get(email).n; d.close();
    const bodies = new Set([...burst, ...after].map((x) => JSON.stringify(x.data)));
    out.cases.push({ method, burstStatuses: [...new Set(burst.map((x) => x.status))], afterStatuses: [...new Set(after.map((x) => x.status))],
      bookingsCreated: rows, distinctResponses: bodies.size, changedSlotSameKey: { status: changed.status, sameAnswerAsFirst: JSON.stringify(changed.data) === JSON.stringify(burst[0].data) } });
  }
  // A paid deposit link opened twice (Stripe retries webhooks the same way).
  const { slots } = await slotsFor(s.base, 'portrait');
  const b = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() }, body: { package: 'portrait', slot: slots[2].key, name: 'Pay Twice', email: 'paytwice@example.test', agree: true, method: 'card' } });
  await Promise.all(Array.from({ length: 10 }, () => L.call(s.base, 'GET', `/api/dev/pay/${b.data.token}`)));
  const d = new DatabaseSync(s.dbFile, { readOnly: true });
  out.payTwice = { confirmationEmails: d.prepare("SELECT COUNT(*) n FROM outbox o JOIN bookings b ON b.id = o.booking_id WHERE b.token = ? AND o.kind = 'confirmation'").get(b.data.token).n };
  d.close();
  out.checks = liveDupes(s.dbFile);
  s.stop(); return out;
}

/* ---------- 5. hold churn ---------- */
async function churn({ holds = 120 } = {}) {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: OPEN });
  const { slots } = await slotsFor(s.base, 'portrait', 120);
  const made = [];
  for (let i = 0; i < holds; i++) {
    const r = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
      body: { package: 'portrait', slot: slots[i].key, name: `Churn ${i}`, email: `churn${i}@example.test`, agree: true, method: i % 4 === 0 ? 'zelle' : 'card' } });
    made.push({ slot: slots[i].key, token: r.data.token, method: i % 4 === 0 ? 'zelle' : 'card' });
  }
  const before = (await slotsFor(s.base, 'portrait', 120)).slots.length;
  // Wind the clock: every hold's window has passed (holds last 30 min for card, 24 h for Zelle).
  const w = new DatabaseSync(s.dbFile);
  w.prepare("UPDATE bookings SET hold_expires_at = ? WHERE status = 'hold'").run(new Date(Date.now() - 1000).toISOString()); w.close();
  const t = performance.now();
  const after = (await slotsFor(s.base, 'portrait', 120)).slots.length;
  const freedMs = performance.now() - t;
  // Half the expired times get taken by someone new; then every original client pays late.
  for (let i = 0; i < holds; i += 2) {
    await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
      body: { package: 'portrait', slot: made[i].slot, name: `Newcomer ${i}`, email: `new${i}@example.test`, agree: true, method: 'card' } }).then((r) => L.call(s.base, 'GET', `/api/dev/pay/${r.data.token}`));
  }
  const latePays = await Promise.all(made.filter((m) => m.method === 'card').map((m) => L.call(s.base, 'GET', `/api/dev/pay/${m.token}`)));
  const views = await Promise.all(made.filter((m) => m.method === 'card').map((m) => L.call(s.base, 'GET', `/api/bookings/${m.token}`)));
  const viewStatus = {}; for (const v of views) { const k = v.status === 200 ? v.data.status : `http ${v.status}`; viewStatus[k] = (viewStatus[k] || 0) + 1; }
  const d = new DatabaseSync(s.dbFile, { readOnly: true });
  const refundMails = d.prepare("SELECT COUNT(*) n FROM outbox WHERE kind = 'admin_needs_refund'").get().n; d.close();
  const admin = await L.call(s.base, 'GET', '/api/admin/bookings', { cookie });
  const out = { scenario: 'churn', holds, slotsFreeWhileHeld: before, slotsFreeAfterExpiry: after, freedWithinMs: n(freedMs),
    latePayRedirects: L.stats(latePays).byStatus, clientSeesAfterLatePay: viewStatus, adminRefundEmails: refundMails,
    needsRefundVisibleInAdmin: admin.data.bookings.filter((b) => b.status === 'needs_refund').length, checks: liveDupes(s.dbFile) };
  s.stop(); return out;
}

/* ---------- 6. Zelle backlog / hold squatting, on the real calendar ---------- */
async function zelle() {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, {}); // the photographer's real rules: 4 shoots a week, 60 days ahead, 48 h notice
  const startSlots = (await slotsFor(s.base, 'portrait')).slots.length;
  let requests = 0; let held = 0; const t0 = performance.now();
  // One visitor, no payment, junk details: how many requests until nothing can be booked for 24 hours?
  for (;;) {
    const { slots } = await slotsFor(s.base, pick(PACKAGES)); requests++;
    if (!slots.length) break;
    const r = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() },
      body: { package: 'portrait', slot: slots[0].key, name: 'Zz', email: `x${held}@example.test`, agree: true, method: 'zelle' } });
    requests++; if (r.status === 200) held++;
    if (requests > 500) break;
  }
  const secs = (performance.now() - t0) / 1000;
  const after = { portrait: 0, couples: 0, automotive: 0 };
  for (const p of PACKAGES) after[p] = (await slotsFor(s.base, p)).slots.length;
  const list = await L.call(s.base, 'GET', '/api/admin/bookings', { cookie });
  const d = new DatabaseSync(s.dbFile, { readOnly: true });
  const mails = d.prepare("SELECT kind, COUNT(*) n FROM outbox GROUP BY kind").all(); d.close();
  const out = { scenario: 'zelle', calendar: 'real (weeklyCap 4, 60 days, 48 h notice)', bookableSlotsBefore: startSlots,
    zelleHoldsToBlockEverything: held, requestsNeeded: requests, seconds: n(secs), bookableSlotsAfter: after, blockedForHours: 24,
    holdsShownInAdminBookingsTab: list.data.bookings.filter((b) => b.status === 'hold').length,
    emailsQueued: Object.fromEntries(mails.map((m) => [m.kind, m.n])), checks: liveDupes(s.dbFile) };
  s.stop(); return out;
}

/* ---------- 9. email outbox and Undo ---------- */
async function outbox() {
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: Object.assign({}, OPEN, { minNoticeHours: 0 }) });
  const log = [];
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => client(s.base, i, { zelleShare: 0.3, abandonShare: 0, log })));
  const booked = results.filter((r) => r.outcome === 'booked');
  const list = (await L.call(s.base, 'GET', '/api/admin/bookings', { cookie })).data.bookings;
  const byToken = Object.fromEntries(list.map((b) => [b.token, b]));
  const ids = booked.map((b) => byToken[b.token].id);
  // Cancel 5 and undo at once; deliver 5 by link and undo at once; mark 5 balances paid and undo.
  const act = (id, what, body) => L.call(s.base, 'POST', `/api/admin/bookings/${id}/${what}`, { cookie, body: body || {} });
  const undo = (id, action, previous) => L.call(s.base, 'POST', `/api/admin/bookings/${id}/undo`, { cookie, body: { action, previous } });
  const quick = [];
  for (const id of ids.slice(0, 5)) { const c = await act(id, 'cancel'); quick.push((await undo(id, 'cancel', c.data.previous)).status); }
  for (const id of ids.slice(5, 10)) { const c = await act(id, 'deliver', { galleryUrl: 'https://example.test/g' }); quick.push((await undo(id, 'deliver', c.data.previous)).status); }
  // These five go out and stay out: the job loop runs once a minute.
  const late = ids.slice(10, 15);
  for (const id of late) await act(id, 'deliver', { galleryUrl: 'https://example.test/g' });
  const d0 = new DatabaseSync(s.dbFile, { readOnly: true });
  const inlineCheck = d0.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'sent' AND kind = 'gallery'").get().n; d0.close();
  // Wait for one job tick to send everything that's due.
  let waited = 0;
  for (; waited < 80; waited += 5) {
    await L.sleep(5000);
    const d = new DatabaseSync(s.dbFile, { readOnly: true });
    const pending = d.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'pending' AND send_after <= ?").get(new Date().toISOString()).n; d.close();
    if (!pending) break;
  }
  const lateUndo = [];
  for (const id of late) lateUndo.push((await undo(id, 'deliver', 'prepped')).status);
  const d = new DatabaseSync(s.dbFile, { readOnly: true });
  const kinds = d.prepare("SELECT kind, status, COUNT(*) n FROM outbox GROUP BY kind, status ORDER BY kind").all();
  d.close();
  const printed = (s.log().match(/--- email \(not sent/g) || []).length;
  const out = { scenario: 'outbox', clients: 40, booked: booked.length, undoWithinWindow: quick, galleryEmailsSentBeforeJobRan: inlineCheck,
    secondsUntilJobSent: waited + 5, undoAfterSent: lateUndo, outboxByKindAndStatus: kinds, emailsPrintedByJobLoop: printed, checks: liveDupes(s.dbFile) };
  s.stop(); return out;
}

const SCENARIOS = { steady, ramp, stampede, retry, churn, zelle, outbox };
if (require.main === module) {
  const name = process.argv[2];
  if (!SCENARIOS[name]) { console.error('Scenarios: ' + Object.keys(SCENARIOS).join(', ')); process.exit(1); }
  SCENARIOS[name]().then((out) => {
    const file = name + (process.env.CAL ? '-' + process.env.CAL : '');
    L.save(file, out);
    console.log(JSON.stringify(out, (k, v) => (k === 'steps' ? undefined : v), 2));
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { client, SCENARIOS };

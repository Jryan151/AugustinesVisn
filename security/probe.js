'use strict';
/* =====================================================================
   security/probe.js — the defensive audit, run against a throwaway LOCAL copy only.

   Run:  node security/probe.js
   Writes security/results/probe.json. Every request goes to 127.0.0.1. Test files are harmless stand-ins made here
   (a text file, an inert SVG, a JPG header in front of HTML text). No real data, no real email, no payments.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { boot, client } = require('./boot');

const results = {};
const note = (k, v) => { results[k] = v; console.log(k.padEnd(34), JSON.stringify(v)); };
const key = () => crypto.randomBytes(16).toString('hex');
const PKG = { slug: 'golden', name: 'Golden hour', summary: 'Test package', minutes: 60, photos: 30, turnaround_days: 7, price_cents: 30000, deposit_cents: 5000 };

async function slots(c) {
  const d = (await c.call('GET', '/api/availability?package=golden&days=62')).body.days;
  return d.flatMap((x) => x.slots.map((s) => s.key));
}
function outboxCounts(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare('SELECT kind, COUNT(*) n FROM outbox GROUP BY kind').all();
  db.close();
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}
function makeJpg(dir, name, w = 800, h = 600, color = 'orange') {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-frames:v', '1', f]);
  return f;
}

(async () => {
  /* =================== A. production-like copy (NODE_ENV=production, behind a proxy) =================== */
  const s = await boot({ prod: true, trustProxy: true });
  // As on the server: nginx in front adds the visitor's real address. The admin and the stranger are on different connections.
  const admin = client(s.base, { nginxAs: '198.51.100.1' });
  const anon = client(s.base, { nginxAs: '203.0.113.66' });
  try {
    note('A0 admin login', (await admin.call('POST', '/api/admin/login', { body: { password: s.password } })).status);
    note('A0 create package', (await admin.call('POST', '/api/admin/packages', { body: PKG })).status);

    // ---- Part 4: access control. Every admin route, no login. ----
    const adminGets = ['/api/admin/bookings', '/api/admin/clients', '/api/admin/settings', '/api/admin/site', '/api/admin/payments', '/api/admin/email', '/api/admin/bookings/1/photos', '/api/admin/photos/1/original', '/api/admin/packages/1/portfolio'];
    const openGets = [];
    for (const u of adminGets) { const r = await anon.call('GET', u); if (r.status !== 401) openGets.push([u, r.status]); }
    note('A1 admin GETs open without login', openGets);
    const writes = [['PUT', '/api/admin/bookings/1/photos'], ['PUT', '/api/admin/site/background'], ['PUT', '/api/admin/packages/1/image'], ['PUT', '/api/admin/payments/zelle-qr'],
      ['POST', '/api/admin/bookings/1/cancel'], ['POST', '/api/admin/packages'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/email/test'], ['POST', '/api/admin/demo']];
    const openWrites = [];
    for (const [m, u] of writes) { const r = await anon.call(m, u, { body: {} }); if (r.status !== 401) openWrites.push([m, u, r.status]); }
    note('A1 admin writes open without login', openWrites);

    // Forged / expired admin cookies.
    const future = Date.now() + 86400000;
    const forged = [`av_admin=${future}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, `av_admin=${future}.`, 'av_admin=9999999999999.x', `av_admin=${Date.now() - 1000}.${admin.cookie.split('.').pop()}`];
    note('A2 forged/expired cookies (want all 401)', await Promise.all(forged.map(async (ck) => (await anon.call('GET', '/api/admin/bookings', { headers: { cookie: ck } })).status)));

    // ---- Dev "pretend paid" endpoints must be closed in production. ----
    note('A3 dev pay endpoints in prod', [(await anon.call('GET', '/api/dev/pay/AAAAAAAAAAAAAAAAAAAAAAAA')).status, (await anon.call('GET', '/api/dev/pay-balance/AAAAAAAAAAAAAAAAAAAAAAAA')).status]);

    // ---- Part 1: what errors give away. ----
    const errs = {
      badJson: await anon.call('POST', '/api/bookings/verify', { raw: '{nope', headers: { 'content-type': 'application/json' } }),
      array: await anon.call('POST', '/api/bookings/verify', { body: '[1,2]' }),
      huge: await anon.call('POST', '/api/requests', { body: JSON.stringify({ note: 'x'.repeat(200000) }) }),
      nested: await anon.call('POST', '/api/requests', { body: '['.repeat(20000) + ']'.repeat(20000) }),
      badSlot: await anon.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot: '../../x', name: 'A B', email: 'a@example.test', agree: true, method: 'in_person' } }),
    };
    note('A4 error responses', Object.fromEntries(Object.entries(errs).map(([k, r]) => [k, [r.status, r.body && r.body.error]])));
    const leaks = Object.values(errs).filter((r) => /\/home\/|\/srv\/|at .*\.js:\d+|SQLITE|SELECT /i.test(JSON.stringify(r.body)));
    note('A4 stack traces/paths/SQL in responses', leaks.length);
    note('A4 server alive after nested JSON', (await anon.call('GET', '/api/health')).status);

    // ---- Part 1: does the browser ever see a secret? Scan everything public/ serves. ----
    const pub = fs.readdirSync(path.join(__dirname, '..', 'public')).filter((f) => /\.(js|html)$/.test(f));
    const secretHits = pub.filter((f) => /sk_(live|test)_|STRIPE_SECRET|RESEND_API_KEY|SESSION_SECRET|ADMIN_PASSWORD/.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')));
    note('A5 secret names in browser files', secretHits);

    // ---- Part 3: login brute force. Same address, then a spoofed address header each try. ----
    const same = [];
    for (let i = 0; i < 8; i++) same.push((await anon.call('POST', '/api/admin/login', { body: { password: 'wrong' + i } })).status);
    note('A6 login, same address (want 429 after 5)', same);
    const spoof = [];
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) spoof.push((await anon.call('POST', '/api/admin/login', { headers: { 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}` }, body: { password: 'wrong' + i } })).status);
    const perMin = Math.round(200 / ((Date.now() - t0) / 60000));
    note('A6 login, fake X-Forwarded-For each try', { tries: 200, blocked429: spoof.filter((x) => x === 429).length, wrong401: spoof.filter((x) => x === 401).length, guessesPerMinuteSingleClient: perMin });
    const cf = [];
    for (let i = 0; i < 20; i++) cf.push((await anon.call('POST', '/api/admin/login', { headers: { 'cf-connecting-ip': `10.8.0.${i}` }, body: { password: 'w' } })).status);
    note('A6 login, fake CF-Connecting-IP each try', { tries: 20, blocked429: cf.filter((x) => x === 429).length });

    // ---- Part 3: in-person code emails to strangers (no money, no verification needed to send one). ----
    const c7 = client(s.base, { nginxAs: '203.0.113.71' });
    const free = await slots(anon);
    note('A7 open slots in 62 days', free.length);
    const before = outboxCounts(s.dbFile);
    const codeSends = [];
    for (let i = 0; i < 40; i++) {
      codeSends.push((await c7.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot: free[0], name: 'Test Person', email: `stranger${i}@example.test`, agree: true, method: 'in_person' } })).status);
    }
    const after = outboxCounts(s.dbFile);
    note('A7 code emails to 40 different addresses', { accepted: codeSends.filter((x) => x === 200).length, blocked: codeSends.filter((x) => x === 429).length, booking_code_emails_queued: (after.booking_code || 0) - (before.booking_code || 0) });
    const c7b = client(s.base, { nginxAs: '203.0.113.72' });
    const oneAddr = [];
    for (let i = 0; i < 6; i++) oneAddr.push((await c7b.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot: free[0], name: 'Test Person', email: 'same@example.test', agree: true, method: 'in_person' } })).status);
    note('A7 code emails to ONE address x6 (want 429 after 3)', oneAddr);

    // ---- Part 3: guessing the 6-digit code. ----
    const c8 = client(s.base, { nginxAs: '203.0.113.73' });
    const st = await c8.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot: free[1], name: 'Guess Me', email: 'guess@example.test', agree: true, method: 'in_person' } });
    const guesses = [];
    for (let i = 0; i < 8; i++) guesses.push((await c8.call('POST', '/api/bookings/verify', { body: { verify: st.body.verify, code: String(100000 + i) } })).status);
    note('A8 wrong code guesses (want 429 after 5)', guesses);

    // ---- Part 3: "request another time" floods the photographer's inbox? ----
    const b2 = outboxCounts(s.dbFile);
    const c9 = client(s.base, { nginxAs: '203.0.113.74' });
    const reqs = [];
    for (let i = 0; i < 30; i++) reqs.push((await c9.call('POST', '/api/requests', { body: { package: 'golden', date: '2026-12-20', time: '12:00', name: 'Req Person', email: `req${i}@example.test`, note: 'hi' } })).status);
    const a2 = outboxCounts(s.dbFile);
    note('A9 time requests from 30 addresses', { accepted: reqs.filter((x) => x === 200).length, statuses: [...new Set(reqs)], admin_emails_queued: (a2.admin_time_request || 0) - (b2.admin_time_request || 0) });

    // ---- Part 3: Zelle on — can a script hold every slot with no money and no email check? ----
    note('A10 turn on Zelle (admin)', (await admin.call('PUT', '/api/admin/payments', { body: { zelle: { enabled: true, recipient: 'owner@example.test', name: 'Owner', holdHours: 24 } } })).status);
    const open = await slots(anon);
    const b3 = outboxCounts(s.dbFile);
    const c10 = client(s.base, { nginxAs: '203.0.113.75' });
    const holds = await Promise.all(open.map((slot, i) => c10.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot, name: 'Junk Hold', email: `junk${i}@example.test`, agree: true, method: 'zelle' } })));
    const left = await slots(anon);
    const a3 = outboxCounts(s.dbFile);
    note('A10 Zelle hold squatting', { slotsBefore: open.length, holdsAccepted: holds.filter((r) => r.status === 200).length, slotsLeftForRealClients: left.length, holdLengthHours: 24, zelle_emails_to_strangers: (a3.zelle_deposit || 0) - (b3.zelle_deposit || 0) });
    // "I sent it" on one hold stretches it.
    const tok = holds.find((r) => r.status === 200).body.token;
    const sent = await c10.call('POST', `/api/bookings/${tok}/zelle-sent`, { body: {} });
    note('A10 "zelle-sent" stretches hold to', sent.body && sent.body.holdExpiresAt);

    // ---- Part 1: booking tokens can't be walked. ----
    const walk = await Promise.all(['1', 'AAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA', tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A')].map(async (t) => (await anon.call('GET', '/api/bookings/' + t)).status));
    note('A11 guessed booking tokens', walk);
    note('A11 token length (chars, ~bits)', [tok.length, tok.length * 6]);
    const view = (await anon.call('GET', '/api/bookings/' + tok)).body;
    note('A11 fields a client sees on their booking', Object.keys(view));

    // ---- Part 4: does client text come back escaped? (checked in the browser code below; here: stored as typed) ----
    await anon.call('POST', '/api/requests', { body: { package: 'golden', date: '2026-12-21', time: '12:00', name: '<img src=x onerror=alert(1)>', email: 'xss@example.test', note: '<script>alert(1)</script>' } });

    // ---- Part 2: uploads (admin), with harmless fake bad files. ----
    const work = fs.mkdtempSync(path.join(s.dir, 'files-'));
    const files = {
      'text.js': Buffer.from('console.log("harmless test file")'),
      'page.html': Buffer.from('<html><body>harmless test page</body></html>'),
      'inert.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>/* inert placeholder */</script></svg>'),
      'fake.jpg': Buffer.from('not really an image'),
      'polyglot.jpg': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<html><script>/* inert */</script></html>')]),
      'real.jpg': fs.readFileSync(makeJpg(work, 'real.jpg')),
    };
    const up = {};
    for (const [n, buf] of Object.entries(files)) {
      const r = await admin.call('PUT', '/api/admin/site/background', { raw: buf, headers: { 'content-type': 'application/octet-stream', 'x-file-name': n } });
      up[n] = [r.status, r.body && (r.body.error || 'stored')];
    }
    note('B1 upload types (admin)', up);
    // Where did the polyglot go and how is it served?
    const site = (await admin.call('GET', '/api/admin/site')).body.background;
    const servedTypes = [];
    for (const bg of site) {
      const url = bg.web || bg.url || bg.src || (bg.files && bg.files.web);
      const u = typeof url === 'string' ? url : JSON.stringify(bg).match(/\/media\/[^"]+/)[0];
      const r = await anon.call('GET', u);
      servedTypes.push([u.replace(/\/media\/[^-.]+/, '/media/<random>'), r.status, r.headers.get('content-type'), r.headers.get('x-content-type-options')]);
    }
    note('B2 how stored uploads are served', servedTypes);
    // Path tricks in the name header are ignored (files get random names).
    const trav = await admin.call('PUT', '/api/admin/site/background', { raw: files['real.jpg'], headers: { 'x-file-name': encodeURIComponent('../../../../etc/passwd') } });
    const stray = fs.existsSync(path.join(s.dir, 'etc')) || fs.readdirSync(path.join(s.dir)).some((f) => f === 'passwd');
    note('B3 traversal name upload', { status: trav.status, fileWrittenOutsideFolder: stray });
    // Static file server traversal.
    const travGet = await Promise.all(['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/media/..%2f..%2fbooking.sqlite', '/.env', '/../.env', '/%2e%2e%2f.env'].map(async (u) => [u, (await fetch(s.base + u)).status]));
    note('B4 reading files outside public/', travGet);
    // Over the size limit (generated zeros, never downloaded).
    const big = Buffer.alloc(61 * 1024 * 1024);
    const rss0 = process.memoryUsage().rss;
    const tooBig = await admin.call('PUT', '/api/admin/site/background', { raw: big });
    note('B5 61 MB upload', tooBig.status);
    // Unauthenticated upload of a big body: refused before it is read?
    const t1 = Date.now();
    const anonBig = await anon.call('PUT', '/api/admin/bookings/1/photos', { raw: Buffer.alloc(20 * 1024 * 1024) });
    note('B6 anonymous 20 MB upload', { status: anonBig.status, ms: Date.now() - t1 });
    void rss0;
  } finally {
    results.serverLogTail = s.log.join('').split('\n').filter((l) => /Error|error/.test(l)).slice(-10);
    await s.stop(); s.cleanup();
  }

  /* =================== B. the paid-photo gate (development copy, so the stand-in "pay" link exists) =================== */
  const d = await boot({ prod: false, trustProxy: false });
  const A = client(d.base); const C = client(d.base);
  try {
    await A.call('POST', '/api/admin/login', { body: { password: d.password } });
    await A.call('POST', '/api/admin/packages', { body: PKG });
    const free = await slots(C);
    const mk = async (slot, who) => {
      const r = await C.call('POST', '/api/bookings', { headers: { 'idempotency-key': key() }, body: { package: 'golden', slot, name: who, email: `${who.toLowerCase().replace(/\W/g, '')}@example.test`, agree: true, method: 'card' } });
      await C.call('GET', '/api/dev/pay/' + r.body.token);
      const list = (await A.call('GET', '/api/admin/bookings')).body.bookings;
      return list.find((b) => b.token === r.body.token || b.client_name === who);
    };
    const one = await mk(free[0], 'Client One');
    const two = await mk(free[1], 'Client Two');
    const tokOne = (await A.call('GET', '/api/admin/bookings')).body.bookings.find((b) => b.id === one.id).token;
    const tokTwo = (await A.call('GET', '/api/admin/bookings')).body.bookings.find((b) => b.id === two.id).token;
    const work = fs.mkdtempSync(path.join(d.dir, 'files-'));
    const up1 = await A.call('PUT', `/api/admin/bookings/${one.id}/photos`, { raw: fs.readFileSync(makeJpg(work, 'a.jpg', 1600, 1200, 'blue')), headers: { 'x-file-name': 'a.jpg' } });
    const up2 = await A.call('PUT', `/api/admin/bookings/${two.id}/photos`, { raw: fs.readFileSync(makeJpg(work, 'b.jpg', 1600, 1200, 'green')), headers: { 'x-file-name': 'b.jpg' } });
    const del1 = await A.call('POST', `/api/admin/bookings/${one.id}/deliver`, { body: {} });
    await A.call('POST', `/api/admin/bookings/${two.id}/deliver`, { body: {} });
    note('C0 setup (uploads, deliver)', [up1.status, up2.status, del1.status]);
    await new Promise((r) => setTimeout(r, 4000)); // let the watermark job finish
    const p1 = up1.body.photo.id; const p2 = up2.body.photo.id;
    const gate = {
      originalUnpaid: (await C.call('GET', `/g/${tokOne}/${p1}/original`)).status,
      zipUnpaid: (await C.call('GET', `/g/${tokOne}/all.zip`)).status,
      webUnpaid: (await C.call('GET', `/g/${tokOne}/${p1}/web`)).status,
    };
    const proof = (await C.call('GET', `/g/${tokOne}/${p1}/web`)).buf;
    const clean = (await A.call('GET', `/api/admin/photos/${p1}/web`)).buf;
    gate.proofDiffersFromClean = !proof.equals(clean);
    note('C1 unpaid gallery gate', gate);
    // Cross-client: client one's token + client two's photo id.
    note('C2 client one asks for client two\'s photo', (await C.call('GET', `/g/${tokOne}/${p2}/web`)).status);
    // A client can mark their OWN balance paid with the dev link — only possible when NODE_ENV isn't production.
    await C.call('GET', '/api/dev/pay-balance/' + tokTwo);
    note('C3 dev copy: client unlocks own photos via dev link', (await C.call('GET', `/g/${tokTwo}/${p2}/original`)).status);
    // Stored text back in Admin: the API returns it raw; escaping is the page's job (checked by reading admin.js).
    note('C4 admin.js renders text via esc()', /esc\(/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8')));
  } finally { await d.stop(); d.cleanup(); }

  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'probe.json'), JSON.stringify(results, null, 2));
  console.log('\nWrote security/results/probe.json');
})().catch((e) => { console.error(e); process.exit(1); });

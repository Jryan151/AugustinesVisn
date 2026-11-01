'use strict';
/* The security rules: the real visitor address, the login limits, logging out on a new password, the caps on the
   public forms, clean "too large" answers, and the test-only shortcuts staying off on a live (https) site. */
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.ADMIN_EMAIL = 'me@example.com';
process.env.TRUST_PROXY = '1'; // as on the server, behind nginx
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../server');
const db = require('../src/db');
const config = require('../src/config');
const auth = require('../src/auth');
const limits = require('../src/limits');

let server; let base;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], morning: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
});
test.after(() => server.close());
test.beforeEach(() => { auth._reset(); for (const l of Object.values(limits.perIp)) l.reset(); limits.state.enforce = false; });

// "from" is the address nginx saw (it adds it last); "fake" is whatever a visitor typed in front.
const call = async (method, p, body, { from = '203.0.113.9', fake, headers = {} } = {}) => {
  const xff = (fake ? fake + ', ' : '') + from;
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, headers), body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const key = () => crypto.randomUUID();
let slotIndex = 0;
async function freeSlot() {
  const r = await call('GET', '/api/availability?package=portrait&days=60');
  return r.data.days.flatMap((d) => d.slots)[slotIndex++].key;
}
const outbox = (kind) => db.get('SELECT COUNT(*) n FROM outbox WHERE kind = ?', [kind]).n;

test('the visitor address: the last X-Forwarded-For entry; Cloudflare’s header only from Cloudflare', () => {
  const req = (xff, cf) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: Object.assign({ 'x-forwarded-for': xff }, cf ? { 'cf-connecting-ip': cf } : {}) });
  assert.equal(limits.clientIp(req('6.6.6.6, 203.0.113.9')), '203.0.113.9');
  assert.equal(limits.clientIp(req('203.0.113.9', '6.6.6.6')), '203.0.113.9', 'not from Cloudflare: its header is ignored');
  assert.equal(limits.clientIp(req('1.1.1.1, 172.70.1.2', '198.51.100.7')), '198.51.100.7', 'from Cloudflare: its header is the visitor');
  assert.equal(limits.clientIp(req('2606:4700::1', '198.51.100.8')), '198.51.100.8');
  assert.equal(limits.clientIp(req('', null)), '127.0.0.1');
});

test('login: 5 wrong per connection, and a made-up address header doesn’t reset it', async () => {
  for (let i = 0; i < auth.PER_IP; i++) assert.equal((await call('POST', '/api/admin/login', { password: 'nope' + i }, { fake: `10.0.0.${i}` })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' }, { fake: '10.9.9.9' })).status, 429);
  assert.equal((await call('POST', '/api/admin/login', { password: 'test-password' }, { fake: '10.9.9.8' })).status, 429, 'even the right password waits');
  assert.equal((await call('POST', '/api/admin/login', { password: 'test-password' }, { from: '203.0.113.50' })).status, 200, 'another connection is fine');
});

test('login: many wrong tries across many connections close it, email the owner once, and keep logged-in devices working', async () => {
  const ok = await call('POST', '/api/admin/login', { password: 'test-password' }, { from: '198.51.100.1' });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const before = outbox('admin_login_alert');
  for (let i = 0; i < auth.SITE_WIDE + 3; i++) await call('POST', '/api/admin/login', { password: 'guess' + i }, { from: `192.0.2.${i}` });
  assert.equal((await call('POST', '/api/admin/login', { password: 'test-password' }, { from: '198.51.100.2' })).status, 429, 'closed for everyone');
  assert.equal(outbox('admin_login_alert') - before, 1, 'one alert, not one per guess');
  assert.equal((await call('GET', '/api/admin/bookings', undefined, { headers: { cookie } })).status, 200, 'the photographer’s phone stays logged in');
});

test('a new ADMIN_PASSWORD logs every device out; forged and far-future cookies don’t work', async () => {
  const ok = await call('POST', '/api/admin/login', { password: 'test-password' });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/bookings', undefined, { headers: { cookie } })).status, 200);
  const sig = cookie.split('.').pop();
  assert.equal((await call('GET', '/api/admin/bookings', undefined, { headers: { cookie: `av_admin=${Date.now() + 365 * 86400000}.${sig}` } })).status, 401);
  config.adminPassword = 'a-brand-new-password';
  try {
    assert.equal((await call('GET', '/api/admin/bookings', undefined, { headers: { cookie } })).status, 401);
  } finally { config.adminPassword = 'test-password'; }
});

test('in person: at most 5 code emails an hour from one connection, whatever the address', async () => {
  limits.state.enforce = true;
  const slot = await freeSlot();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Test Person', email: `p${i}@example.com`, agree: true, method: 'in_person' }, { headers: { 'Idempotency-Key': key() } })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Real Client', email: 'real@example.com', agree: true, method: 'in_person' }, { from: '203.0.113.77', headers: { 'Idempotency-Key': key() } })).status, 200, 'other visitors unaffected');
});

test('holds: one email can’t hold more than two times; one connection can’t make more than 10 tries an hour', async () => {
  limits.state.enforce = true;
  const out = [];
  for (let i = 0; i < 3; i++) out.push((await call('POST', '/api/bookings', { package: 'portrait', slot: await freeSlot(), name: 'Holder', email: 'holder@example.com', agree: true, method: 'card' }, { from: '203.0.113.20', headers: { 'Idempotency-Key': key() } })).status);
  assert.deepEqual(out, [200, 200, 429]);
  const k = key(); const slot = await freeSlot();
  const first = await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Retry', email: 'retry@example.com', agree: true, method: 'card' }, { from: '203.0.113.21', headers: { 'Idempotency-Key': k } });
  for (let i = 0; i < 12; i++) await call('POST', '/api/bookings', { package: 'portrait', slot, name: 'Retry', email: 'retry@example.com', agree: true, method: 'card' }, { from: '203.0.113.21', headers: { 'Idempotency-Key': k } });
  assert.equal(limits.perIp.bookings.count('203.0.113.21'), 1, 'a double tap (same key) isn’t counted again');
  assert.equal(first.status, 200);
  const many = [];
  for (let i = 0; i < 11; i++) many.push((await call('POST', '/api/bookings', { package: 'portrait', slot: 'nope', name: 'Script', email: `s${i}@example.com`, agree: true, method: 'card' }, { from: '203.0.113.22', headers: { 'Idempotency-Key': key() } })).status);
  assert.equal(many[9], 409); assert.equal(many[10], 429);
  const day = [];
  for (let i = 0; i < 6; i++) day.push((await call('POST', '/api/bookings', { package: 'portrait', slot: await freeSlot(), name: 'Squatter', email: `q${i}@example.com`, agree: true, method: 'card' }, { from: '203.0.113.23', headers: { 'Idempotency-Key': key() } })).status);
  assert.deepEqual(day, [200, 200, 200, 200, 200, 429], 'five holds a day from one connection, whatever the email');
});

test('"request another time": at most 5 an hour from one connection', async () => {
  limits.state.enforce = true;
  const out = [];
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) out.push((await call('POST', '/api/requests', { package: 'portrait', date, time: '12:00', name: 'Req Person', email: `r${i}@example.com` }, { from: '203.0.113.30' })).status);
  assert.deepEqual(out.slice(-2), [200, 429]);
});

test('a too-large request gets a clean 413, not a cut connection', async () => {
  const r = await call('POST', '/api/requests', JSON.stringify({ note: 'x'.repeat(300 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('a live (https) site never gets the test shortcuts, even without NODE_ENV=production', () => {
  const root = path.join(__dirname, '..');
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
    "const c=require('./src/config');const p=require('./src/payments');process.stdout.write(JSON.stringify({live:c.isLive,pw:c.adminPassword,dev:p.devMode()}))"],
  { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'development', BASE_URL: 'https://book.example.com', ADMIN_PASSWORD: '', DB_FILE: ':memory:', DEMO_DIR: path.join(require('os').tmpdir(), 'av-test-demo') }, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(JSON.parse(out), { live: true, pw: '', dev: false });
});

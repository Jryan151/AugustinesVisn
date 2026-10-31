'use strict';
/* =====================================================================
   stress/lib.js — shared pieces for the stress scripts. Never points at production.

   - startServer(): runs server.js as a child process on a throwaway data folder, email printed (never sent),
     Stripe off (so the dev "pay" link is used). Samples the server's memory every 250 ms.
   - call(): one HTTP request, timed, with a JSON body and cookies.
   - stats(): p50/p95/p99 and error counts by status code.
   ===================================================================== */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RESULTS = path.join(__dirname, 'results');
const PASSWORD = 'stress-only-password';

async function startServer({ dataDir, port = 3900 + Math.floor(Math.random() * 90) } = {}) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'av-stress-'));
  const env = Object.assign({}, process.env, {
    NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', BASE_URL: `http://127.0.0.1:${port}`,
    ADMIN_PASSWORD: PASSWORD, ADMIN_EMAIL: 'photographer@example.test', SESSION_SECRET: 'stress-secret',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '', MAIL_FROM: '',
    DB_FILE: path.join(dataDir, 'booking.sqlite'), BACKUP_DIR: path.join(dataDir, 'backups'),
    MEDIA_DIR: path.join(dataDir, 'media'), GALLERY_DIR: path.join(dataDir, 'galleries'),
  });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  let peakRss = 0;
  const sample = () => {
    try {
      const s = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const kb = Number((/VmRSS:\s+(\d+)/.exec(s) || [])[1] || 0);
      peakRss = Math.max(peakRss, kb * 1024);
    } catch (e) { /* exited */ }
  };
  const timer = setInterval(sample, 250);
  return {
    base, dataDir, dbFile: env.DB_FILE, child,
    peakRss: () => { sample(); return peakRss; },
    resetPeak: () => { peakRss = 0; sample(); },
    sizes: () => {
      const size = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
      return { db: size(env.DB_FILE), wal: size(env.DB_FILE + '-wal') };
    },
    log: () => fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8'),
    stop: () => { clearInterval(timer); child.kill(); },
  };
}

/** One request. Returns { status, ms, data, headers }. Never throws on HTTP errors; a dropped connection is status 0. */
async function call(base, method, url, { body, headers = {}, cookie, raw } = {}) {
  const t = performance.now();
  try {
    const h = Object.assign({}, headers);
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    const buf = Buffer.from(await r.arrayBuffer());
    let data = buf;
    if ((r.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(buf.toString()); } catch (e) { /* leave raw */ } }
    return { status: r.status, ms: performance.now() - t, data, headers: r.headers, bytes: buf.length };
  } catch (e) {
    return { status: 0, ms: performance.now() - t, data: { error: e.message } };
  }
}

async function login(base) {
  const r = await call(base, 'POST', '/api/admin/login', { body: { password: PASSWORD } });
  return String(r.headers.get('set-cookie') || '').split(';')[0];
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
function stats(results) {
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const round = (n) => Math.round(n * 10) / 10;
  return { requests: results.length, p50: round(pct(ms, 50)), p95: round(pct(ms, 95)), p99: round(pct(ms, 99)), max: round(ms[ms.length - 1] || 0), byStatus };
}

function save(name, data) {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, name + '.json'), JSON.stringify(data, null, 2));
}

const key = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens Zelle and loosens/tightens the calendar, as the photographer would in Admin. */
async function configure(base, cookie, { availability, zelle = true } = {}) {
  if (zelle) await call(base, 'PUT', '/api/admin/payments', { cookie, body: { zelle: { enabled: true, recipient: 'photographer@example.test', name: 'Augustine', holdHours: 24 } } });
  if (availability) {
    const cur = await call(base, 'GET', '/api/admin/settings', { cookie });
    const body = Object.assign({}, cur.data, { availability: Object.assign({}, cur.data.availability, availability) });
    const r = await call(base, 'PUT', '/api/admin/settings', { cookie, body });
    if (r.status !== 200) throw new Error('settings: ' + JSON.stringify(r.data));
  }
}

module.exports = { startServer, call, login, stats, save, key, sleep, configure, PASSWORD, ROOT };

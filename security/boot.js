'use strict';
/* =====================================================================
   security/boot.js — starts a throwaway local copy of the site for the probes.

   LOCAL ONLY. Listens on 127.0.0.1, uses a fresh temp folder for the database and photos, throwaway passwords,
   no Stripe key and no email key (emails are printed to the console, never sent). Nothing here can reach the live
   site, its database, or any real client.
   ===================================================================== */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

async function boot({ prod = true, trustProxy = prod, port = 4100 + Math.floor(Math.random() * 800) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sec-'));
  const password = crypto.randomBytes(12).toString('hex'); // throwaway, for this run only
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir,
    NODE_ENV: prod ? 'production' : 'development',
    HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: trustProxy ? '1' : '0',
    BASE_URL: `http://127.0.0.1:${port}`,
    ADMIN_PASSWORD: password, SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_EMAIL: 'owner@example.test',
    STRIPE_SECRET_KEY: '', RESEND_API_KEY: '', // nothing real: no payments, no email leaves this machine
    DB_FILE: path.join(dir, 'booking.sqlite'), MEDIA_DIR: path.join(dir, 'media'), GALLERY_DIR: path.join(dir, 'galleries'),
    BACKUP_DIR: path.join(dir, 'backups'), DEMO_DIR: path.join(dir, 'demo'),
  };
  // Guard: refuse to run unless every address points at this machine.
  if (!/^http:\/\/127\.0\.0\.1:/.test(env.BASE_URL)) throw new Error('Refusing: not local.');
  const log = [];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], { env, cwd: ROOT });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = () => new Promise((r) => { child.once('exit', r); child.kill(); });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { base, dir, password, dbFile: env.DB_FILE, child, log, stop, cleanup };
}

/** A tiny fetch helper: returns { status, body, headers } and keeps the admin cookie when asked.
    `nginxAs`: act like nginx in front of the app, which adds the address it really saw to the END of X-Forwarded-For
    (after anything the visitor typed), exactly as the server's nginx file does. */
function client(base, { nginxAs } = {}) {
  let cookie = '';
  async function call(method, url, { body, headers = {}, raw } = {}) {
    const h = Object.assign({}, headers);
    if (nginxAs) h['x-forwarded-for'] = (h['x-forwarded-for'] ? h['x-forwarded-for'] + ', ' : '') + nginxAs;
    if (cookie && !h.cookie) h.cookie = cookie;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] = 'application/json'; }
    let r;
    try { r = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' }); } catch (e) { return { status: 'connection-reset', headers: new Headers(), buf: Buffer.alloc(0), body: null }; }
    const sc = r.headers.get('set-cookie');
    if (sc && /av_admin=/.test(sc)) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf, body: type.includes('json') ? JSON.parse(buf.toString() || 'null') : buf.toString('latin1').slice(0, 300) };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

module.exports = { boot, client };

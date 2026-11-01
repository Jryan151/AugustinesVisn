'use strict';
/* =====================================================================
   auth.js — the photographer's login for Admin. One person, one password (ADMIN_PASSWORD).

   The login is a signed cookie ("expiry.signature"), so there's no session table. It's HttpOnly (scripts can't read
   it), SameSite=Strict (other sites can't use it), and Secure in production. The signature also covers the password
   itself, so changing ADMIN_PASSWORD logs every device out at once (the fix if a phone is lost or the password leaks).

   Guessing the password is slowed three ways:
     - each wrong password waits a moment before answering
     - one connection gets 5 wrong tries per 15 minutes (limits.clientIp: a made-up address header doesn't reset it)
     - across everyone, 30 wrong tries in 15 minutes closes the login for 15 minutes and emails the photographer.
       A device that's already logged in keeps working, so a guesser can't lock the photographer out of his own phone.
   ===================================================================== */
const crypto = require('crypto');
const config = require('./config');
const limits = require('./limits');
const { HttpError } = require('./http');

const COOKIE = 'av_admin';
const LIFETIME = 14 * 86400000;
const WINDOW = 15 * 60000;
const PER_IP = 5;
const SITE_WIDE = 30;
const WRONG_DELAY_MS = config.isTest ? 0 : 400;

const failsByIp = limits.limiter(PER_IP, WINDOW);
const failsAll = limits.limiter(SITE_WIDE, WINDOW);
let closedUntil = 0;

// The password's fingerprint is part of every signature: a new password, and every old login stops working.
const fingerprint = () => crypto.createHash('sha256').update('admin-pw:' + config.adminPassword).digest('base64url').slice(0, 16);
const sign = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s + ':' + fingerprint()).digest('base64url');
const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function cookieFor(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.isLive ? '; Secure' : ''}`;
}

function isAdmin(req) {
  if (!config.adminPassword) return false;
  const v = String((req.cookies || {})[COOKIE] || '');
  const [exp, sig] = v.split('.');
  if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) < Date.now() || Number(exp) > Date.now() + LIFETIME) return false;
  return sameText(sign('admin:' + exp), sig);
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Log in first.');
}

/** Tells the photographer once per lockout that someone is guessing. Through the outbox, like every email. */
function alertOwner(ip) {
  try {
    require('./mail').queueNote({
      kind: 'admin_login_alert', to: config.adminEmail,
      subject: 'Someone is guessing your Admin password',
      body: `There were ${SITE_WIDE} wrong Admin passwords in 15 minutes (the last from ${ip}), so the login is closed for 15 minutes.\n\nIf this was you, just wait. If not, nothing was opened: your bookings and photos are safe. To be sure, change ADMIN_PASSWORD in the server's .env and restart; that also logs out every device.\n\n${config.baseUrl}/admin`,
    });
  } catch (e) { console.error('login alert:', e.message); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(req, res) {
  const ip = limits.clientIp(req);
  const now = Date.now();
  if (now < closedUntil) throw new HttpError(429, 'Login is paused for a few minutes after too many wrong passwords. Try again shortly.');
  if (failsByIp.count(ip, now) >= PER_IP) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  if (!config.adminPassword || !sameText(String(req.body.password || ''), config.adminPassword)) {
    failsByIp.hit(ip, now);
    if (!failsAll.hit('all', now)) {
      closedUntil = now + WINDOW;
      failsAll.reset();
      alertOwner(ip);
    }
    await wait(WRONG_DELAY_MS);
    throw new HttpError(401, 'That password isn’t right.');
  }
  failsByIp.clear(ip);
  const exp = String(now + LIFETIME);
  res.setHeader('Set-Cookie', cookieFor(`${exp}.${sign('admin:' + exp)}`, LIFETIME / 1000));
  res.json(200, { ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', cookieFor('', 0));
  res.json(200, { ok: true });
}

/** For tests: forget every wrong try and reopen the login. */
function _reset() { failsByIp.reset(); failsAll.reset(); closedUntil = 0; }

module.exports = { isAdmin, requireAdmin, login, logout, _reset, PER_IP, SITE_WIDE };

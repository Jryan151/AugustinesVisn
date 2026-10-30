'use strict';
/* =====================================================================
   auth.js — the photographer's login for Admin. One person, one password (ADMIN_PASSWORD).

   The login is a signed cookie ("expiry.signature"), so there's no session table. It's HttpOnly (scripts can't read
   it), SameSite=Strict (other sites can't use it), and Secure in production. Wrong passwords are limited to 5 per
   10 minutes per address.
   ===================================================================== */
const crypto = require('crypto');
const config = require('./config');
const { HttpError } = require('./http');

const COOKIE = 'av_admin';
const LIFETIME = 14 * 86400000;
const fails = new Map(); // ip → [times]

const sign = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('base64url');
const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function cookieFor(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.isProd ? '; Secure' : ''}`;
}

function isAdmin(req) {
  const v = String((req.cookies || {})[COOKIE] || '');
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameText(sign('admin:' + exp), sig);
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Log in first.');
}

function clientIp(req) { return req.socket.remoteAddress || ''; }

function login(req, res) {
  const ip = clientIp(req);
  const recent = (fails.get(ip) || []).filter((t) => t > Date.now() - 600000);
  if (recent.length >= 5) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  if (!config.adminPassword || !sameText(String(req.body.password || ''), config.adminPassword)) {
    recent.push(Date.now()); fails.set(ip, recent);
    throw new HttpError(401, 'That password isn’t right.');
  }
  fails.delete(ip);
  const exp = String(Date.now() + LIFETIME);
  res.setHeader('Set-Cookie', cookieFor(`${exp}.${sign('admin:' + exp)}`, LIFETIME / 1000));
  res.json(200, { ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', cookieFor('', 0));
  res.json(200, { ok: true });
}

module.exports = { isAdmin, requireAdmin, login, logout };

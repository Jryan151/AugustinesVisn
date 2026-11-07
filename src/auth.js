'use strict';
/* =====================================================================
   auth.js — the photographer's login for Admin. One person, one password (ADMIN_PASSWORD).

   The login is a signed cookie ("expiry.signature"), so there's no session table. It's HttpOnly (scripts can't read
   it), SameSite=Strict (other sites can't use it), and Secure in production. Wrong passwords are limited to 5 per
   10 minutes per address, and 30 per 10 minutes overall, so changing address doesn't buy more guesses.

   The visitor's address: with TRUST_PROXY=1, only a request from nginx on this same machine (loopback) may name it,
   in X-Real-IP (nginx sets it, after checking Cloudflare's ranges: deploy/nginx-booking.conf). Headers a visitor can
   type themselves (CF-Connecting-IP, the start of X-Forwarded-For) are never believed, or anyone reaching the server
   directly could claim a new address on every try.
   ===================================================================== */
const crypto = require('crypto');
const config = require('./config');
const { HttpError } = require('./http');

const COOKIE = 'av_admin';
const LIFETIME = 14 * 86400000;
const WINDOW = 600000;
const MAX_PER_IP = 5;
const MAX_TOTAL = 30;
const fails = new Map(); // ip → [times]
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (!config.trustProxy || !LOOPBACK.has(peer)) return peer;
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  // Older nginx files don't send X-Real-IP. The LAST X-Forwarded-For entry is the one nginx added itself.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : peer;
}

function login(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  let total = 0;
  for (const [k, times] of fails) {
    const kept = times.filter((t) => t > now - WINDOW);
    if (kept.length) { fails.set(k, kept); total += kept.length; } else fails.delete(k);
  }
  const recent = fails.get(ip) || [];
  if (recent.length >= MAX_PER_IP || total >= MAX_TOTAL) throw new HttpError(429, 'Too many tries. Wait 10 minutes.');
  if (!config.adminPassword || !sameText(String(req.body.password || ''), config.adminPassword)) {
    recent.push(now); fails.set(ip, recent);
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

module.exports = { isAdmin, requireAdmin, login, logout, clientIp, _resetFails: () => fails.clear() };

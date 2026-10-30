'use strict';
/* =====================================================================
   config.js — every setting that comes from the environment, read once.

   Reads .env itself (KEY=value lines, # for comments), so there's no dotenv to install. A value already set in the
   real environment wins over the file.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(__dirname, '..', '.env'));

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const isProd = env('NODE_ENV', 'development') === 'production';
const isTest = env('NODE_ENV', '') === 'test';

const config = {
  isProd,
  isTest,
  port: parseInt(env('PORT', '3000'), 10),
  // Listen on this machine only: nginx (or Caddy) in front is the only way in.
  host: env('HOST', '127.0.0.1'),
  // Behind nginx/Cloudflare, the visitor's real address comes in a header. Only trusted when this is on.
  trustProxy: env('TRUST_PROXY', '0') === '1',
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  businessName: env('BUSINESS_NAME', 'Augustine’s Vision'),
  adminEmail: env('ADMIN_EMAIL', ''),
  adminPassword: env('ADMIN_PASSWORD', isProd ? '' : 'admin'),
  sessionSecret: env('SESSION_SECRET', crypto.randomBytes(32).toString('hex')),
  latitude: parseFloat(env('LATITUDE', '33.4484')),
  longitude: parseFloat(env('LONGITUDE', '-112.0740')),
  timezone: env('TIMEZONE', 'America/Phoenix'),
  stripeSecretKey: env('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
  resendApiKey: env('RESEND_API_KEY', ''),
  mailFrom: env('MAIL_FROM', ''),
  dbFile: env('DB_FILE', path.join(__dirname, '..', 'data', 'booking.sqlite')),
  backupDir: env('BACKUP_DIR', path.join(__dirname, '..', 'data', 'backups')),
  publicDir: path.join(__dirname, '..', 'public'),
  // A client's time is held this long while they pay. Stripe's checkout can't expire sooner than 30 minutes.
  holdMinutes: 30,
};

if (isProd && !config.adminPassword) {
  console.warn('ADMIN_PASSWORD is not set, so the admin page can’t be opened. Set it in .env.');
}

module.exports = config;

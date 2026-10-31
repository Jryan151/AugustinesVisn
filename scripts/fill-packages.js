'use strict';
/* =====================================================================
   scripts/fill-packages.js — fills in the photographer's own packages with the suggested details (src/packagefill.js).

     sudo runuser -u booking -- node /srv/booking/scripts/fill-packages.js

   Only packages whose name matches a suggestion (Portrait, Couples, Sports) are touched, and only their description,
   length, photo count, turnaround, price and deposit. Names, link names, photos, order and "open for booking" stay
   exactly as they are. It shows every change first and asks before saving anything. Safe while the site is running.
   ===================================================================== */
const path = require('path');
const readline = require('readline');
process.chdir(path.join(__dirname, '..')); // so the database path in .env resolves the same way the site does
const config = require('../src/config');
const db = require('../src/db');
const { FIELDS, forName } = require('../src/packagefill');

db.init(config.dbFile);
const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0);
const show = (k, v) => (k.endsWith('_cents') ? money(v) : k === 'summary' ? `"${v}"` : String(v));
const LABEL = { summary: 'Description', minutes: 'Length (min)', photos: 'Edited photos', turnaround_days: 'Ready in (days)', price_cents: 'Price', deposit_cents: 'Deposit' };

const plan = [];
for (const p of db.all('SELECT * FROM packages WHERE offer = 0 ORDER BY sort, id')) {
  const s = forName(p.name);
  if (!s) { console.log(`\n${p.name}: no suggestion, left as it is.`); continue; }
  const changes = FIELDS.filter((k) => p[k] !== s[k]);
  if (!changes.length) { console.log(`\n${p.name}: already filled in.`); continue; }
  console.log(`\n${p.name}`);
  for (const k of changes) console.log(`  ${LABEL[k].padEnd(16)} ${show(k, p[k])}  ->  ${show(k, s[k])}`);
  plan.push({ p, s });
}
if (!plan.length) { console.log('\nNothing to change.'); process.exit(0); }

const apply = () => {
  db.tx(() => { for (const { p, s } of plan) db.run(`UPDATE packages SET ${FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...FIELDS.map((k) => s[k]), p.id]); });
  console.log(`\nSaved. ${plan.length} package${plan.length === 1 ? '' : 's'} filled in; the site shows them now. Change anything later in Admin > Setup > Packages.`);
};
if (process.argv.includes('--yes')) apply();
else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nSave these changes? (y/N) ', (a) => { rl.close(); if (/^y(es)?$/i.test(a.trim())) apply(); else console.log('Nothing changed.'); });
}

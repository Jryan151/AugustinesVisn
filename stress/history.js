'use strict';
/* =====================================================================
   stress/history.js — scenario 7: a year of history (scale 1 and scale 10).

   node stress/history.js [scale]
   Seeds a throwaway database, then times what the photographer and the job loop touch every day:
   the Bookings and Clients lists, a 62-day availability lookup, and one pass of the job loop (which runs every 15 s
   on the same thread that answers requests).
   ===================================================================== */
const { execFileSync } = require('child_process');
const path = require('path');
const L = require('./lib');

const scale = Number(process.argv[2] || 1);
const SCRATCH_DB = process.env.KEEP_DB || '';

async function timeIt(base, url, cookie, times = 15) {
  const rs = [];
  for (let i = 0; i < times; i++) rs.push(await L.call(base, 'GET', url, { cookie }));
  return Object.assign(L.stats(rs), { bytes: rs[rs.length - 1].bytes });
}

(async () => {
  // First start creates the schema and packages; stop, seed, start again on the same data.
  let s = await L.startServer(); s.stop(); await L.sleep(300);
  const seeded = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'seed.js'), s.dbFile, String(scale)]).toString());
  s = await L.startServer({ dataDir: s.dataDir });
  const cookie = await L.login(s.base);

  const bookings = await timeIt(s.base, '/api/admin/bookings', cookie);
  const listRows = (await L.call(s.base, 'GET', '/api/admin/bookings', { cookie })).data.bookings;
  const byStatus = {}; for (const b of listRows) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const clients = await timeIt(s.base, '/api/admin/clients', cookie);
  const clientRows = (await L.call(s.base, 'GET', '/api/admin/clients', { cookie })).data.clients.length;
  const avail = await timeIt(s.base, '/api/availability?package=portrait&days=62', null);

  // One job-loop pass, in its own process on the same database (it's the same code the server runs every 15 s).
  const tickMs = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const config = require('./src/config'); const db = require('./src/db'); db.init(config.dbFile);
    const jobs = require('./src/jobs'); const mail = require('./src/mail');
    const t = []; for (let i = 0; i < 5; i++) { const a = performance.now(); jobs.queueDue(new Date()); t.push(performance.now() - a); }
    const rows = db.get("SELECT COUNT(*) n FROM bookings WHERE status = 'delivered'").n;
    console.log(JSON.stringify({ queueDueMs: t.map((x) => Math.round(x * 10) / 10), deliveredRowsScanned: rows }));
  `], { cwd: L.ROOT, env: Object.assign({}, process.env, { DB_FILE: s.dbFile, NODE_ENV: 'development' }) }).toString().trim().split('\n').pop());

  // While the Bookings list loads over and over, how slow does a client's booking page get?
  const clientDuring = [];
  let stop = false;
  const hammer = (async () => { while (!stop) await L.call(s.base, 'GET', '/api/admin/bookings', { cookie }); })();
  for (let i = 0; i < 40; i++) clientDuring.push(await L.call(s.base, 'GET', '/api/availability?package=couples&days=62'));
  stop = true; await hammer;

  const out = { scenario: 'history', scale, seeded, adminBookings: Object.assign(bookings, { rows: listRows.length, byStatus }),
    adminClients: Object.assign(clients, { rows: clientRows }), availability62Days: avail, jobLoop: tickMs,
    clientAvailabilityWhileAdminListLoads: L.stats(clientDuring), files: s.sizes(), peakRssMB: Math.round(s.peakRss() / 1048576) };
  if (SCRATCH_DB) require('fs').copyFileSync(s.dbFile, SCRATCH_DB);
  s.stop();
  L.save('history-x' + scale, out);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

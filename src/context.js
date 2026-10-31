'use strict';
/* =====================================================================
   context.js — which site a request belongs to: the real one, or the demo.

   The demo lives on the same site, behind a switch in Admin that only changes what the photographer's own browser
   sees. Each request runs inside run(demo, …), and everything it starts (database calls, photo work, emails) knows
   which one it belongs to through isDemo(). The demo has its own database and photo folders (db.js, config.js),
   never sends email (mail.js) and never takes real money (payments.js). Everyone else always gets the real site.
   ===================================================================== */
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();
const run = (demo, fn) => store.run({ demo: !!demo }, fn);
const isDemo = () => !!(store.getStore() || {}).demo;

module.exports = { run, isDemo };

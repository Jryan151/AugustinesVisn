'use strict';
/* =====================================================================
   stress/walkthrough.js — Part 2: the admin on a phone (390 × 844), with a seeded year of history.

   node stress/walkthrough.js [scale]
   Uses Playwright (not a dependency of the app: run with NODE_PATH pointing at a global install).
   Measures what the photographer feels: how long until the board shows, how many screens of scrolling it is,
   whether the tab bar fits, and where this week's shoots end up on the page.
   ===================================================================== */
const { execFileSync } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib');

const scale = Number(process.argv[2] || 1);

(async () => {
  let s = await L.startServer(); s.stop(); await L.sleep(300);
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'seed.js'), s.dbFile, String(scale)]);
  s = await L.startServer({ dataDir: s.dataDir });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  // CPU like a mid-range phone.
  const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await page.goto(s.base + '/admin');
  await page.fill('#password', L.PASSWORD);
  const t0 = Date.now();
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#board .col');
  const boardMs = Date.now() - t0;

  const m = await page.evaluate(() => {
    const vh = innerHeight;
    const tabs = document.querySelector('.tabs');
    const cols = [...document.querySelectorAll('#board .col')].map((c) => ({ title: c.querySelector('h3 span').textContent, cards: c.querySelectorAll('.card').length, startsAtScreen: +(c.getBoundingClientRect().top / vh + 1).toFixed(1) }));
    const firstBooked = [...document.querySelectorAll('#board .col')].find((c) => /^Booked/.test(c.querySelector('h3 span').textContent));
    return {
      screensOfScroll: +(document.documentElement.scrollHeight / vh).toFixed(1),
      tabBar: { visibleWidth: tabs.clientWidth, contentWidth: tabs.scrollWidth, tabsHiddenOffscreen: [...tabs.querySelectorAll('[role=tab]')].filter((t) => t.getBoundingClientRect().right > innerWidth).map((t) => t.textContent) },
      columns: cols,
      thisWeeksShootsStartAtScreen: firstBooked ? cols.find((c) => /^Booked/.test(c.title)).startsAtScreen : null,
      domNodes: document.getElementsByTagName('*').length,
    };
  });

  // Clients tab
  const t1 = Date.now();
  await page.click('[data-tab=clients]');
  await page.waitForSelector('#client-list details, #client-list .empty');
  const clientsMs = Date.now() - t1;
  const c = await page.evaluate(() => ({ screens: +(document.documentElement.scrollHeight / innerHeight).toFixed(1), shown: document.querySelectorAll('#client-list details').length }));

  // Coming back to the app (focus) reloads the whole board.
  await page.click('[data-tab=pipeline]');
  let refetches = 0; page.on('request', (r) => { if (r.url().endsWith('/api/admin/bookings')) refetches++; });
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500);

  await page.screenshot({ path: path.join(__dirname, 'results', `admin-board-x${scale}.png`), fullPage: false });
  await browser.close(); s.stop();
  const out = { scenario: 'walkthrough', scale, viewport: '390x844, CPU slowed 4x', loginToBoardMs: boardMs, board: m, clientsTab: { ms: clientsMs, screens: c.screens, clients: c.shown }, boardRefetchesOnThreeAppSwitches: refetches };
  L.save('walkthrough-x' + scale, out);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

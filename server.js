'use strict';
/* =====================================================================
   server.js — starts the site: the API, the pages, and the once-a-minute jobs.

   Run: npm start  (or npm run dev to restart on every save). Needs Node 22.13+ for its built-in SQLite.
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const routes = require('./src/routes');
const jobs = require('./src/jobs');
const sitemedia = require('./src/sitemedia');
const { HttpError, serveStatic, securityHeaders, decorate, parseCookies } = require('./src/http');
const context = require('./src/context');
const auth = require('./src/auth');

// Clean addresses for the pages.
const REWRITES = [
  [/^\/book\/?$/, '/book.html'],
  [/^\/booked\/?$/, '/booked.html'],
  [/^\/admin\/?$/, '/admin.html'],
  [/^\/prep\/[A-Za-z0-9_-]+\/?$/, '/prep.html'],
  [/^\/gallery\/[A-Za-z0-9_-]+\/?$/, '/gallery.html'],
  [/^\/portfolio\/[a-z0-9-]+\/?$/, '/portfolio.html'],
  [/^\/offer\/[a-z0-9-]+\/?$/, '/portfolio.html'],
  [/^\/confirm\/[A-Za-z0-9_.-]+\/?$/, '/confirm.html'],
];

// Pages that get the site background (Admin › Site). The marker in each is <!--SITE_BG--> or, for pages with forms
// (a heavier veil over the photo), <!--SITE_BG strong-->.
// Every page goes through page(), so it also gets the current build stamp on its scripts and styles.
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/book.html': 'book.html', '/booked.html': 'booked.html',
  '/prep.html': 'prep.html', '/admin.html': 'admin.html', '/gallery.html': 'gallery.html', '/portfolio.html': 'portfolio.html', '/confirm.html': 'confirm.html' };

/* A stamp made from the scripts' and styles' contents. Pages ask for "/styles.css?v=<stamp>", which browsers keep for a
   year; a new version has a new stamp, so after an update everyone gets the new files at once, never a stale mix. */
const BUILD = (() => {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(config.publicDir).filter((n) => /\.(js|css)$/.test(n)).sort()) h.update(f).update(fs.readFileSync(path.join(config.publicDir, f)));
  return h.digest('hex').slice(0, 10);
})();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(file, res) {
  const html = fs.readFileSync(path.join(config.publicDir, file), 'utf8')
    .replace('<!--SITE_BG strong-->', () => sitemedia.backgroundMarkup(true))
    .replace('<!--SITE_BG see-through-->', () => sitemedia.backgroundMarkup(false).replace('class="bg"', 'class="bg see-through"'))
    .replace('<!--SITE_BG-->', () => sitemedia.backgroundMarkup(false))
    .replace('<!--ADMIN_BG-->', () => sitemedia.adminBackgroundMarkup())
    .replace(/(src|href)="\/([a-z0-9-]+\.(?:js|css))"/g, `$1="/$2?v=${BUILD}"`)
    .replace('<!--SITE_CSS-->', () => `<link rel="stylesheet" href="/site.css?v=${sitemedia.cssStamp()}">`)
    .replace(/\{\{BRAND\}\}/g, () => esc(config.businessName))
    // In the demo, every page says so (and only the photographer, who switched it on, ever sees it).
    .replace(/<body[^>]*>/, (tag) => (context.isDemo() ? `${tag}\n  <div class="demo-banner" role="note"><b>Demo</b> · sample data, only you see this<button type="button" class="demo-reset">Reset</button><button type="button" class="demo-exit">Exit demo</button></div>` : tag));
  res.setHeader('Cache-Control', 'no-cache');
  res.send(200, html, 'text/html; charset=utf-8');
}

function createApp({ dbFile = config.dbFile } = {}) {
  db.init(dbFile);
  const router = routes.build();
  return http.createServer((req, res) => {
    // The demo: only for the logged-in photographer who switched it on (Admin › Demo). Everyone else, always real.
    req.cookies = parseCookies(req);
    const demo = req.cookies.av_demo === '1' && auth.isAdmin(req);
    return context.run(demo, () => handle(req, res));
  });

  async function handle(req, res) {
    decorate(res);
    securityHeaders(res);
    try {
      const pathname = new URL(req.url, 'http://local').pathname;
      if (req.method === 'GET') {
        let p = pathname;
        for (const [re, to] of REWRITES) if (re.test(p)) { p = to; break; }
        if (PAGES[p]) return page(PAGES[p], res);
      }
      if (await router.handle(req, res)) return;
      if (sitemedia.serveMedia(req, res)) return;
      if (serveStatic(config.publicDir, req, res, REWRITES)) return;
      if (pathname.startsWith('/api/')) return res.json(404, { error: 'Not found.' });
      res.send(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) {
        // A gallery link opened in the browser gets a page, not raw JSON.
        if (/^\/g\//.test(req.url) && e.status === 404) return res.send(404, 'This gallery isn\u2019t available. Check the link in your email.');
        return res.json(e.status, Object.assign({ error: e.message }, e.extra));
      }
      if (/UNIQUE constraint failed: packages\.slug/.test(e.message)) return res.json(400, { error: 'Another package already uses that link name.' });
      console.error(req.method, req.url, e);
      res.json(500, { error: 'Something went wrong on our side. Try again.' });
    }
  }
}

if (require.main === module) {
  const server = createApp();
  server.listen(config.port, config.host, () => {
    console.log(`${config.businessName}: ${config.baseUrl} (admin at /admin)`);
    if (!config.stripeSecretKey) console.log(config.isProd ? 'STRIPE_SECRET_KEY is not set: booking is closed.' : 'No Stripe key: using the development "pay" link.');
  });
  jobs.start();
}

module.exports = { createApp };

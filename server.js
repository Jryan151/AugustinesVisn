'use strict';
/* =====================================================================
   server.js — starts the site: the API, the pages, and the once-a-minute jobs.

   Run: npm start  (or npm run dev to restart on every save). Needs Node 22.13+ for its built-in SQLite.
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const routes = require('./src/routes');
const jobs = require('./src/jobs');
const { HttpError, serveStatic, securityHeaders, decorate } = require('./src/http');

// Clean addresses for the pages.
const REWRITES = [
  [/^\/book\/?$/, '/book.html'],
  [/^\/booked\/?$/, '/booked.html'],
  [/^\/admin\/?$/, '/admin.html'],
  [/^\/prep\/[A-Za-z0-9_-]+\/?$/, '/prep.html'],
];

/* The home page's moving background. Put these in public/media/ and it appears; without them the hero is a still
   warm gradient. hero-poster.jpg shows at once; hero-540.mp4 (phones) and hero-1080.mp4 (big screens) fade in once the
   page has loaded. Keep the clip a seamless 8–12 s loop with no sound. */
function heroMarkup() {
  const has = (f) => fs.existsSync(path.join(config.publicDir, 'media', f));
  if (!has('hero-poster.jpg')) return '<div class="bg" aria-hidden="true"></div>'; // the warm gradient on its own
  const sm = has('hero-540.mp4') ? '/media/hero-540.mp4' : '';
  const lg = has('hero-1080.mp4') ? '/media/hero-1080.mp4' : sm;
  return '<div class="bg" aria-hidden="true"><img class="bg-media" src="/media/hero-poster.jpg" alt="" decoding="async">' +
    (sm || lg ? `<video class="bg-media bg-video" muted playsinline loop preload="none" disablepictureinpicture tabindex="-1" data-sm="${sm || lg}" data-lg="${lg}"></video>` : '') +
    '<div class="bg-veil"></div></div>';
}

function homePage(req, res) {
  const html = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8').replace('<!--HERO_BG-->', heroMarkup());
  res.setHeader('Cache-Control', 'no-cache');
  res.send(200, html, 'text/html; charset=utf-8');
}

function createApp({ dbFile = config.dbFile } = {}) {
  db.init(dbFile);
  const router = routes.build();
  return http.createServer(async (req, res) => {
    decorate(res);
    securityHeaders(res);
    try {
      const pathname = new URL(req.url, 'http://local').pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return homePage(req, res);
      if (await router.handle(req, res)) return;
      if (serveStatic(config.publicDir, req, res, REWRITES)) return;
      if (pathname.startsWith('/api/')) return res.json(404, { error: 'Not found.' });
      res.send(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return res.json(e.status, Object.assign({ error: e.message }, e.extra));
      if (/UNIQUE constraint failed: packages\.slug/.test(e.message)) return res.json(400, { error: 'Another package already uses that link name.' });
      console.error(req.method, req.url, e);
      res.json(500, { error: 'Something went wrong on our side. Try again.' });
    }
  });
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

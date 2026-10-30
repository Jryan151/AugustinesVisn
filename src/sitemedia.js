'use strict';
/* =====================================================================
   sitemedia.js — the photos that dress the site, uploaded in Admin › Site and Admin › Packages.

   - Site background: up to MAX_BG photos behind the public pages. The first shows at once; the rest fade in one
     after another with a slow drift (common.js). With "reduce motion" or data saver, only the first, still.
   - Package image: one photo behind each package's card on the home page (and behind the booking page once that
     package is picked).
   Files live in data/media/ and are served at /media/<name>. Every upload gets a new random name, so browsers can
   cache them for a long time and a replaced photo still shows at once.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const media = require('./media');
const { HttpError } = require('./http');

const MAX_BG = 6;
const url = (name) => '/media/' + name;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The public view of a stored photo: addresses and size. */
function view(f) {
  if (!f || !f.original) return null;
  return { web: url(f.web), thumb: url(f.thumb), width: f.width, height: f.height, key: f.name };
}

/* ---------- site background ---------- */
function backgroundPhotos() { return (db.setting('siteBackground').photos || []); }

async function addBackground(req) {
  const photos = backgroundPhotos();
  if (photos.length >= MAX_BG) { req.resume(); throw new HttpError(400, `Up to ${MAX_BG} background photos. Remove one first.`); }
  const f = await media.storeUpload(req, config.mediaDir);
  // Read again after the (slow) upload, so two uploads at once both land.
  const now = backgroundPhotos();
  db.saveSetting('siteBackground', { photos: now.concat([f]) });
  return backgroundPhotos().map(view);
}
function removeBackground(key) {
  const photos = backgroundPhotos();
  const f = photos.find((p) => p.name === key);
  if (!f) throw new HttpError(404, 'That photo is already gone.');
  db.saveSetting('siteBackground', { photos: photos.filter((p) => p !== f) });
  media.removeFiles(config.mediaDir, f);
  return backgroundPhotos().map(view);
}
/** Moves a photo to the front: the first one is what everyone sees first. */
function firstBackground(key) {
  const photos = backgroundPhotos();
  const f = photos.find((p) => p.name === key);
  if (!f) throw new HttpError(404, 'No such photo.');
  db.saveSetting('siteBackground', { photos: [f].concat(photos.filter((p) => p !== f)) });
  return backgroundPhotos().map(view);
}

/**
 * The background layer for a public page. `strong` puts a heavier veil over it, for pages with forms.
 * Only the first photo loads with the page; the others wait in data-src until the page has settled.
 */
function backgroundMarkup(strong) {
  const photos = backgroundPhotos();
  const imgs = photos.map((p, i) => i === 0
    ? `<img class="bg-photo on" src="${esc(url(p.web))}" width="${p.width}" height="${p.height}" alt="" decoding="async" fetchpriority="high">`
    : `<img class="bg-photo" data-src="${esc(url(p.web))}" width="${p.width}" height="${p.height}" alt="" decoding="async">`).join('');
  return `<div class="bg${strong ? ' strong' : ''}" aria-hidden="true">${imgs}<div class="bg-veil"></div></div>`;
}

/* ---------- package images ---------- */
const packageImage = (pkg) => { try { return pkg.image_json ? JSON.parse(pkg.image_json) : null; } catch (e) { return null; } };

async function setPackageImage(id, req) {
  if (!db.get('SELECT 1 FROM packages WHERE id = ?', [id])) { req.resume(); throw new HttpError(404, 'No such package.'); }
  const f = await media.storeUpload(req, config.mediaDir);
  const old = packageImage(db.get('SELECT image_json FROM packages WHERE id = ?', [id]));
  db.run('UPDATE packages SET image_json = ? WHERE id = ?', [JSON.stringify(f), id]);
  if (old) media.removeFiles(config.mediaDir, old);
  return view(f);
}
function removePackageImage(id) {
  const p = db.get('SELECT image_json FROM packages WHERE id = ?', [id]);
  if (!p) throw new HttpError(404, 'No such package.');
  const old = packageImage(p);
  db.run("UPDATE packages SET image_json = '' WHERE id = ?", [id]);
  if (old) media.removeFiles(config.mediaDir, old);
}

/* ---------- serving /media/<name> ---------- */
function serveMedia(req, res) {
  const m = /^\/media\/([A-Za-z0-9_-]+(?:-web|-thumb)?\.(jpg|png|webp))$/.exec(new URL(req.url, 'http://local').pathname);
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const file = path.join(config.mediaDir, m[1]);
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  res.setHeader('Content-Type', m[2] === 'png' ? 'image/png' : m[2] === 'webp' ? 'image/webp' : 'image/jpeg');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // names never get reused
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { addBackground, removeBackground, firstBackground, backgroundPhotos, backgroundMarkup, setPackageImage, removePackageImage, packageImage, view, serveMedia, MAX_BG };

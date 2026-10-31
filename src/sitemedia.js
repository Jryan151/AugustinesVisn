'use strict';
/* =====================================================================
   sitemedia.js — the photos that dress the site, uploaded in Admin › Setup › Site photos and Packages.

   - Site background: up to MAX_BG photos behind the public pages. The first shows at once; the rest fade in one
     after another with a slow drift (common.js). With "reduce motion" or data saver, only the first, still.
   - Package image: one photo behind each package's card on the home page (and behind the booking page once that
     package is picked).
   Each photo can be nudged in Admin: a focus point (which part stays in view when the frame crops it) and a zoom.
   These go out as /site.css, a tiny stylesheet made from the saved values, so photos are placed right from the first
   paint with no script and no jump. Its address carries a stamp of its contents, so a nudge shows at once.
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

/** The public view of a stored photo: addresses, size, and how it's framed. */
function view(f) {
  if (!f || !f.original) return null;
  return { web: url(f.web), thumb: url(f.thumb), width: f.width, height: f.height, key: f.name, fx: f.fx ?? 50, fy: f.fy ?? 50, zoom: f.zoom ?? 1 };
}

/** Checks a framing: focus 0–100 (% across, % down) and zoom 1–2.5. */
function cleanFrame(b) {
  const num = (v, min, max, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
    return Math.round(n * 100) / 100;
  };
  return { fx: num(b.fx, 0, 100, 'Across'), fy: num(b.fy, 0, 100, 'Down'), zoom: num(b.zoom ?? 1, 1, 2.5, 'Zoom') };
}

function frameBackground(key, body) {
  const photos = backgroundPhotos();
  const i = photos.findIndex((p) => p.name === key);
  if (i < 0) throw new HttpError(404, 'No such photo.');
  photos[i] = Object.assign({}, photos[i], cleanFrame(body));
  db.saveSetting('siteBackground', { photos });
  return backgroundPhotos().map(view);
}
function framePackageImage(id, body) {
  const p = db.get('SELECT image_json FROM packages WHERE id = ?', [id]);
  const img = p && packageImage(p);
  if (!img) throw new HttpError(404, 'This package has no photo yet.');
  const next = Object.assign({}, img, cleanFrame(body));
  db.run('UPDATE packages SET image_json = ? WHERE id = ?', [JSON.stringify(next), id]);
  return view(next);
}

/** The stylesheet that places every nudged photo. Only photos moved off the default get a rule. */
function siteCss() {
  const all = backgroundPhotos().concat(db.all("SELECT image_json FROM packages WHERE image_json != ''").map(packageImage).filter(Boolean));
  return all.filter((f) => f.fx != null).map((f) => `img[data-key="${f.name}"]{object-position:${f.fx}% ${f.fy}%;--fx:${f.fx}%;--fy:${f.fy}%;--zoom:${f.zoom}}`).join('\n') + '\n';
}
const cssStamp = () => require('crypto').createHash('sha256').update(siteCss()).digest('hex').slice(0, 10);

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
    ? `<img class="bg-photo on" data-key="${esc(p.name)}" src="${esc(url(p.web))}" width="${p.width}" height="${p.height}" alt="" decoding="async" fetchpriority="high">`
    : `<img class="bg-photo" data-key="${esc(p.name)}" data-src="${esc(url(p.web))}" width="${p.width}" height="${p.height}" alt="" decoding="async">`).join('');
  return `<div class="bg${strong ? ' strong' : ''}" aria-hidden="true">${imgs}<div class="bg-veil"></div></div>`;
}

/* ---------- package images ---------- */
const packageImage = (pkg) => { try { return pkg.image_json ? JSON.parse(pkg.image_json) : null; } catch (e) { return null; } };

async function setPackageImage(id, req) {
  if (!db.get('SELECT 1 FROM packages WHERE id = ?', [id])) { req.resume(); throw new HttpError(404, 'No such package.'); }
  const f = await media.storeUpload(req, config.mediaDir);
  const old = packageImage(db.get('SELECT image_json FROM packages WHERE id = ?', [id]));
  // A new photo starts centred: its framing is its own.
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

/* ---------- package portfolios: example shots per package (Admin › Setup › Packages), shown on /portfolio/<slug> ---------- */
const MAX_PORTFOLIO = 60;

function portfolio(packageId) {
  return db.all('SELECT id, file_json FROM portfolio WHERE package_id = ? ORDER BY sort, id', [packageId])
    .map((r) => Object.assign(view(JSON.parse(r.file_json)), { id: r.id }));
}
async function addPortfolio(packageId, req) {
  if (!db.get('SELECT 1 FROM packages WHERE id = ?', [packageId])) { req.resume(); throw new HttpError(404, 'No such package.'); }
  if (db.get('SELECT COUNT(*) n FROM portfolio WHERE package_id = ?', [packageId]).n >= MAX_PORTFOLIO) {
    req.resume(); throw new HttpError(400, `Up to ${MAX_PORTFOLIO} portfolio photos per package. Remove one first.`);
  }
  const f = await media.storeUpload(req, config.mediaDir);
  const last = db.get('SELECT COALESCE(MAX(sort), 0) n FROM portfolio WHERE package_id = ?', [packageId]).n;
  db.run('INSERT INTO portfolio (package_id, file_json, sort, created_at) VALUES (?,?,?,?)', [packageId, JSON.stringify(f), last + 1, db.nowIso()]);
  return portfolio(packageId);
}
function removePortfolio(id) {
  const r = db.get('SELECT * FROM portfolio WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'That photo is already gone.');
  db.run('DELETE FROM portfolio WHERE id = ?', [id]);
  media.removeFiles(config.mediaDir, JSON.parse(r.file_json));
  return portfolio(r.package_id);
}
/** Moves a portfolio photo to the front: the first one is what visitors see first. */
function firstPortfolio(id) {
  const r = db.get('SELECT package_id FROM portfolio WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'No such photo.');
  const first = db.get('SELECT COALESCE(MIN(sort), 0) n FROM portfolio WHERE package_id = ?', [r.package_id]).n;
  db.run('UPDATE portfolio SET sort = ? WHERE id = ?', [first - 1, id]);
  return portfolio(r.package_id);
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

module.exports = { portfolio, addPortfolio, removePortfolio, firstPortfolio, MAX_PORTFOLIO, frameBackground, framePackageImage, siteCss, cssStamp, addBackground, removeBackground, firstBackground, backgroundPhotos, backgroundMarkup, setPackageImage, removePackageImage, packageImage, view, serveMedia, MAX_BG };

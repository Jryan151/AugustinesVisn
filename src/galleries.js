'use strict';
/* =====================================================================
   galleries.js — the client's finished photos.

   The photographer uploads photos to a booking in Admin (one file per request, so 40 photos is 40 small steps with
   progress, and one failure doesn't lose the rest). The client sees them only once the booking is delivered, at
   /gallery/<their booking token>: the same secret link their emails use, so no account or password.

   Removing a photo is instant with Undo: the row is marked deleted, and the files are only really deleted a day later
   by the job loop (purgeDeleted).

   "Download all" streams one .zip built on the fly. Photos are already compressed, so the zip just stores them
   (no squeezing): fast, and it needs nothing installed.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const config = require('./config');
const media = require('./media');
const { HttpError } = require('./http');

const dirFor = (bookingId) => path.join(config.galleryDir, String(Number(bookingId)));
const cleanName = (s) => String(s || '').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'photo.jpg';

function list(bookingId) {
  return db.all('SELECT id, file_name, bytes, width, height, created_at FROM photos WHERE booking_id = ? AND deleted_at IS NULL ORDER BY id', [bookingId]);
}
const count = (bookingId) => db.get('SELECT COUNT(*) n FROM photos WHERE booking_id = ? AND deleted_at IS NULL', [bookingId]).n;

async function add(bookingId, req) {
  const b = db.get('SELECT id, status FROM bookings WHERE id = ?', [bookingId]);
  if (!b) throw new HttpError(404, 'No such booking.');
  if (['cancelled', 'expired', 'hold', 'needs_refund'].includes(b.status)) throw new HttpError(400, `A ${b.status} booking can’t have photos.`);
  let name = String(req.headers['x-file-name'] || '');
  try { name = decodeURIComponent(name); } catch (e) { /* keep as sent */ }
  const f = await media.storeUpload(req, dirFor(bookingId));
  const r = db.run('INSERT INTO photos (booking_id, original, web, thumb, file_name, bytes, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [bookingId, f.original, f.web, f.thumb, cleanName(name), f.bytes, f.width, f.height, db.nowIso()]);
  return db.get('SELECT id, file_name, bytes, width, height, created_at FROM photos WHERE id = ?', [r.lastInsertRowid]);
}

function remove(photoId) {
  if (!db.run('UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [db.nowIso(), photoId]).changes) throw new HttpError(404, 'That photo is already gone.');
}
function restore(photoId) {
  if (!db.run('UPDATE photos SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [photoId]).changes) throw new HttpError(409, 'Too late to undo.');
}
/** Really deletes photos removed over a day ago. */
function purgeDeleted(now = new Date()) {
  const old = db.all('SELECT * FROM photos WHERE deleted_at IS NOT NULL AND deleted_at < ?', [new Date(now.getTime() - 86400000).toISOString()]);
  for (const p of old) { media.removeFiles(dirFor(p.booking_id), p); db.run('DELETE FROM photos WHERE id = ?', [p.id]); }
  return old.length;
}

/** The booking whose gallery this token opens, if the client may see it yet (only once delivered). */
function openGallery(token) {
  const b = /^[A-Za-z0-9_-]{16,64}$/.test(String(token || '')) ? db.get('SELECT * FROM bookings WHERE token = ?', [token]) : null;
  if (!b || b.status !== 'delivered' || !count(b.id)) throw new HttpError(404, 'This gallery isn’t ready yet.');
  return b;
}

/** Sends one photo: 'thumb' and 'web' to look at, 'original' as a download with its own file name. */
function sendPhoto(res, photo, size) {
  const file = { thumb: photo.thumb, web: photo.web, original: photo.original }[size];
  if (!file) throw new HttpError(404, 'Not found.');
  const full = path.join(dirFor(photo.booking_id), file);
  let st; try { st = fs.statSync(full); } catch (e) { throw new HttpError(404, 'That photo file is missing.'); }
  const ext = path.extname(file).slice(1);
  res.statusCode = 200;
  res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (size === 'original') res.setHeader('Content-Disposition', `attachment; filename="${photo.file_name.replace(/"/g, '')}"`);
  fs.createReadStream(full).pipe(res);
}

/* ---------- download all: a "stored" zip, written as it goes ---------- */
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function sendZip(res, booking, zipName) {
  const photos = db.all('SELECT * FROM photos WHERE booking_id = ? AND deleted_at IS NULL ORDER BY id', [booking.id]);
  const total = photos.reduce((s, p) => s + p.bytes, 0);
  if (total > 3.5 * 1024 ** 3) throw new HttpError(413, 'This gallery is too big for one download. Download the photos one by one.');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  const write = (buf) => new Promise((ok) => (res.write(buf) ? ok() : res.once('drain', ok)));
  const central = []; const used = new Set(); let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const p of photos) {
    let data;
    try { data = await fs.promises.readFile(path.join(dirFor(booking.id), p.original)); } catch (e) { continue; }
    let name = p.file_name; let n = 2;
    while (used.has(name.toLowerCase())) name = p.file_name.replace(/(\.[^.]*)?$/, (ext) => ` (${n++})${ext || ''}`);
    used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    await write(local); await write(nameBuf); await write(data);
    central.push({ nameBuf, crc, size: data.length, offset });
    offset += 30 + nameBuf.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(time, 12); h.writeUInt16LE(date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28); h.writeUInt32LE(c.offset, 42);
    await write(h); await write(c.nameBuf);
    cdSize += 46 + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  res.end(end);
}

module.exports = { list, count, add, remove, restore, purgeDeleted, openGallery, sendPhoto, sendZip, dirFor };

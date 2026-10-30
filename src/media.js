'use strict';
/* =====================================================================
   media.js — every photo the photographer uploads: site backgrounds, package card images, client galleries.

   An upload is read straight to a temporary file (never held in memory whole), up to MAX_BYTES, and kept only if its
   first bytes really are a JPG, PNG or WebP (not just named like one). Then:
     - its width and height are read from the file, so pages can save the exact space before it loads (no jump)
     - if ffmpeg is installed, a web-size copy is made (long side ≤ 2000 px, and a 600 px thumbnail). Pages show these;
       the original is kept untouched for the client to download. Without ffmpeg, the original is used everywhere.
   iPhone HEIC photos aren't accepted: export as JPG first (every editing app can).

   Where files live (both inside data/, so they survive updates and are in the backups folder's neighbour):
     data/media/       public: site backgrounds and package images, served at /media/<name>
     data/galleries/   private: client photos, only reachable through a booking's secret token
   ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');
const { HttpError } = require('./http');

const MAX_BYTES = 60 * 1024 * 1024; // a full-size camera JPG is 10–30 MB
const EXT = { jpg: '.jpg', png: '.png', webp: '.webp' };

/** What kind of image the bytes are (by their signature), or null. */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Width and height from the file's own header (JPG, PNG, WebP), or null. Reads at most the first 512 KB. */
function dimensions(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(512 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const b = buf.subarray(0, n);
  const kind = sniff(b);
  if (kind === 'png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (kind === 'webp' && b.length >= 30) {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'jpg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size (C0–CF, except C4, C8, CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        let width = b.readUInt16BE(i + 7); let height = b.readUInt16BE(i + 5);
        if (exifRotated(b)) [width, height] = [height, width];
        return { width, height };
      }
      i += 2 + len;
    }
  }
  return null;
}
/** Camera JPGs are often stored sideways with a "rotate me" flag (EXIF orientation 5–8). Browsers honour it. */
function exifRotated(b) {
  const i = b.indexOf(Buffer.from('Exif\0\0'));
  if (i < 0 || i > 65536) return false;
  const t = i + 6; const le = b.toString('ascii', t, t + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  try {
    const ifd = t + u32(t + 4); const count = u16(ifd);
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) return u16(e + 8) >= 5;
    }
  } catch (err) { /* malformed EXIF: treat as upright */ }
  return false;
}

/* ---------- ffmpeg (optional) ---------- */
let ffmpegOk;
function ffmpeg(args, ms = 120000) {
  return new Promise((resolve, reject) => execFile(config.ffmpegPath, args, { timeout: ms, windowsHide: true }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err).slice(-300) })) : resolve())));
}
async function hasFfmpeg() {
  if (ffmpegOk === undefined) {
    if (!config.ffmpegPath || config.ffmpegPath === 'none') ffmpegOk = false;
    else { try { await ffmpeg(['-hide_banner', '-version'], 10000); ffmpegOk = true; } catch (e) { ffmpegOk = false; } }
  }
  return ffmpegOk;
}
/** A JPG copy no longer than `max` px on its long side (never enlarged). False if it couldn't be made. */
async function resized(src, dest, max, quality) {
  if (!(await hasFfmpeg())) return false;
  try {
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf',
      `scale='if(gt(iw,ih),min(${max},iw),-2)':'if(gt(iw,ih),-2,min(${max},ih))'`, '-frames:v', '1', '-q:v', String(quality), dest]);
    return fs.existsSync(dest);
  } catch (e) { console.error('resize:', e.stderr || e.message); return false; }
}

/* ---------- receiving an upload ---------- */

/** Reads the request body to a temp file (max MAX_BYTES). Returns { tmp, bytes, kind }. Throws plain-English errors. */
function receive(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BYTES) { req.resume(); return reject(new HttpError(413, 'That photo is over 60 MB. Export it smaller.')); }
    const tmp = path.join(os.tmpdir(), 'av-up-' + crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let bytes = 0; let head = Buffer.alloc(0); let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); req.resume(); reject(e); };
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) return fail(new HttpError(413, 'That photo is over 60 MB. Export it smaller.'));
      if (head.length < 16) head = Buffer.concat([head, c.subarray(0, 16)]);
      if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        const kind = sniff(head);
        if (!bytes) return fail(new HttpError(400, 'The file was empty.'));
        if (!kind) return fail(new HttpError(415, 'Only JPG, PNG or WebP photos. (iPhone HEIC: export as JPG first.)'));
        resolve({ tmp, bytes, kind });
      });
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'The upload was cut off. Try again.')));
  });
}

/**
 * Saves an uploaded photo into `dir` under a fresh random name. Returns
 * { name, ext, bytes, width, height, web, thumb } — `web` and `thumb` are file names (the original's when no copies).
 */
async function storeUpload(req, dir) {
  const up = await receive(req);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(12).toString('base64url');
  const original = name + EXT[up.kind];
  const dest = path.join(dir, original);
  try {
    await fs.promises.copyFile(up.tmp, dest);
  } finally { fs.rm(up.tmp, { force: true }, () => {}); }
  const dims = dimensions(dest) || { width: 0, height: 0 };
  const web = (await resized(dest, path.join(dir, name + '-web.jpg'), 2000, 3)) ? name + '-web.jpg' : original;
  const thumb = (await resized(dest, path.join(dir, name + '-thumb.jpg'), 600, 4)) ? name + '-thumb.jpg' : web;
  return { name, original, bytes: up.bytes, width: dims.width, height: dims.height, web, thumb };
}

/** Deletes a stored photo and its copies. */
function removeFiles(dir, f) {
  for (const n of new Set([f.original, f.web, f.thumb])) if (n && /^[A-Za-z0-9_-]+(-web|-thumb)?\.(jpg|png|webp)$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
}

const _reset = () => { ffmpegOk = undefined; };
module.exports = { storeUpload, removeFiles, dimensions, sniff, hasFfmpeg, MAX_BYTES, _reset };

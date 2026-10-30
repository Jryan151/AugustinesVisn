'use strict';
/* =====================================================================
   watermark.js — the proof copies a client sees before their balance is paid.

   Each client photo gets two watermarked copies (2000 px and a 600 px thumbnail), made from the original with ffmpeg:
     - the brand name large across the middle, in the brand's own typeface (public/fonts), semi-transparent
     - two faint bands of the name at a quarter and three quarters down, so cropping out the middle doesn't clear it
   The original is never touched: it's what the client downloads once their balance is paid.

   Copies are made when a photo is uploaded, or, for a photo that doesn't have them yet (uploaded before watermarks
   existed, or while ffmpeg was missing), the first time they're asked for. If they can't be made, nothing clean is
   ever shown in their place: the gallery shows "preview not available" for that photo.
   ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');
const media = require('./media');

const FONT = path.join(config.publicDir, 'fonts', 'InstrumentSerif-Regular.ttf');
const pending = new Map(); // photo id → promise, so two requests at once make the copies once

const brand = () => config.businessName.toUpperCase();

/** Output size for a long side of `max`, never enlarged. Even numbers, as JPEG encoders like. */
function fit(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(2, Math.round((w * s) / 2) * 2), h: Math.max(2, Math.round((h * s) / 2) * 2) };
}

/** The ffmpeg filter: scale, then the big centre mark and two faint bands. Font sizes come from the output size. */
function filter(w, h, textFile, bandFile) {
  const n = brand().length;
  const big = Math.max(12, Math.round(Math.min((w * 0.82) / (n * 0.56), h * 0.16)));
  const small = Math.max(8, Math.round(big * 0.32));
  const common = `fontfile='${FONT.replace(/'/g, "\\'")}':fontcolor=white`;
  return [
    `scale=${w}:${h}`,
    `drawtext=${common}@0.42:textfile='${textFile}':fontsize=${big}:shadowcolor=black@0.3:shadowx=2:shadowy=2:x=(w-text_w)/2:y=(h-text_h)/2`,
    `drawtext=${common}@0.2:textfile='${bandFile}':fontsize=${small}:x=(w-text_w)/2:y=h*0.25-text_h/2`,
    `drawtext=${common}@0.2:textfile='${bandFile}':fontsize=${small}:x=(w-text_w)/2:y=h*0.75-text_h/2`,
  ].join(',');
}

function run(args) {
  return new Promise((resolve, reject) => execFile(config.ffmpegPath, args, { timeout: 120000, windowsHide: true },
    (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err).slice(-300) })) : resolve())));
}

/**
 * Makes the watermarked copies for a stored photo in `dir`. Returns { wm, wmThumb } (file names), or null if they
 * can't be made (no ffmpeg, or it failed).
 */
async function make(dir, photo) {
  if (!(await media.hasFfmpeg()) || !fs.existsSync(FONT)) return null;
  const src = path.join(dir, photo.original);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-wm-'));
  const textFile = path.join(tmp, 'mark.txt');
  const bandFile = path.join(tmp, 'band.txt');
  fs.writeFileSync(textFile, brand());
  fs.writeFileSync(bandFile, Array(8).fill(brand()).join('      '));
  const base = path.parse(photo.original).name;
  const name = (kind) => `${base}-${kind}-${crypto.randomBytes(3).toString('hex')}.jpg`;
  const out = { wm: name('wm'), wmThumb: name('wmthumb') };
  try {
    // The photo's real shape (sideways camera files included) comes from the stored width and height.
    for (const [file, max, q] of [[out.wm, 2000, 3], [out.wmThumb, 600, 4]]) {
      const { w, h } = fit(photo.width || 2000, photo.height || 1333, max);
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', filter(w, h, textFile, bandFile), '-frames:v', '1', '-q:v', String(q), path.join(dir, file)]);
    }
    return out;
  } catch (e) {
    console.error('watermark:', e.stderr || e.message);
    for (const f of Object.values(out)) fs.rmSync(path.join(dir, f), { force: true });
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The copies for this photo, made now if missing. `save` stores the new names. Never makes them twice at once. */
async function ensure(dir, photo, save) {
  if (photo.wm && photo.wm_thumb && fs.existsSync(path.join(dir, photo.wm))) return { wm: photo.wm, wmThumb: photo.wm_thumb };
  if (!pending.has(photo.id)) {
    pending.set(photo.id, make(dir, photo).then((r) => { if (r) save(r); return r; }).finally(() => pending.delete(photo.id)));
  }
  return pending.get(photo.id);
}

module.exports = { make, ensure, fit, filter, FONT };

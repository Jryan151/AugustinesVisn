'use strict';
/* =====================================================================
   stress/gallery.js — scenario 8: uploading and delivering galleries, then many clients opening them.

   node stress/gallery.js [galleries] [photosEach]
   - Makes test JPGs with ffmpeg (12, 24 and 45 megapixel, like real camera files).
   - Uploads to several bookings at once, the way Admin does it (one photo at a time per gallery).
   - Counts ffmpeg processes running at the same moment, and the server's memory.
   - Delivers without the balance paid: every byte a client gets must be a watermarked proof.
   - Pays the balance, then many clients download the zip at once.
   ===================================================================== */
const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib');

const GALLERIES = Number(process.argv[2] || 3);
const EACH = Number(process.argv[3] || 100);
const n = (v) => Math.round(v * 10) / 10;

function makePhotos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const sizes = [[4240, 2832], [6000, 4000], [8256, 5504]];
  const files = [];
  for (let i = 0; i < 9; i++) {
    const [w, h] = sizes[i % 3];
    const f = path.join(dir, `cam-${i}.jpg`);
    if (!fs.existsSync(f)) {
      // noise + gradient compresses like a real photo (several MB), unlike a flat colour
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=${w}x${h}:seed=${i}`,
        '-vf', 'noise=alls=12:allf=t', '-frames:v', '1', '-q:v', '3', f]);
    }
    files.push(f);
  }
  return files;
}

const ffmpegCount = () => { try { return Number(execSync('pgrep -c -x ffmpeg || true').toString().trim()) || 0; } catch (e) { return 0; } };

(async () => {
  const photos = makePhotos(path.join(os.tmpdir(), 'av-stress-photos'));
  const photoBytes = photos.map((f) => fs.statSync(f).size);
  const s = await L.startServer(); const cookie = await L.login(s.base);
  await L.configure(s.base, cookie, { availability: { morning: [0, 1, 2, 3, 4, 5, 6], evening: [0, 1, 2, 3, 4, 5, 6], weeklyCap: 50, minNoticeHours: 0, maxDaysAhead: 365 } });

  // Booked clients to deliver to.
  const avail = await L.call(s.base, 'GET', '/api/availability?package=couples&days=30');
  const slots = avail.data.days.flatMap((d) => d.slots);
  const tokens = [];
  for (let g = 0; g < GALLERIES; g++) {
    const b = await L.call(s.base, 'POST', '/api/bookings', { headers: { 'Idempotency-Key': L.key() }, body: { package: 'couples', slot: slots[g].key, name: `Gallery ${g}`, email: `gal${g}@example.test`, agree: true, method: 'card' } });
    await L.call(s.base, 'GET', `/api/dev/pay/${b.data.token}`);
    tokens.push(b.data.token);
  }
  const list = (await L.call(s.base, 'GET', '/api/admin/bookings', { cookie })).data.bookings;
  const ids = tokens.map((t) => list.find((b) => b.token === t).id);

  // Upload: one at a time per gallery (like Admin), all galleries at once.
  let peakFfmpeg = 0; let sampling = true;
  const sampler = (async () => { while (sampling) { peakFfmpeg = Math.max(peakFfmpeg, ffmpegCount()); await L.sleep(200); } })();
  s.resetPeak();
  const up = []; const t0 = performance.now();
  await Promise.all(ids.map(async (id, g) => {
    for (let i = 0; i < EACH; i++) {
      const f = photos[(i + g) % photos.length];
      up.push(await L.call(s.base, 'PUT', `/api/admin/bookings/${id}/photos`, { cookie, raw: true, body: fs.readFileSync(f), headers: { 'X-File-Name': `IMG_${g}_${i}.jpg`, 'Content-Type': 'image/jpeg' } }));
    }
  }));
  const uploadSecs = (performance.now() - t0) / 1000;
  const rssUpload = s.peakRss();
  // Wait for the background proofs to finish.
  const t1 = performance.now(); let missing = 0;
  for (let i = 0; i < 600; i++) {
    const d = new DatabaseSync(s.dbFile, { readOnly: true });
    missing = d.prepare("SELECT COUNT(*) n FROM photos WHERE wm = '' OR wm IS NULL").get().n; d.close();
    if (!missing) break;
    await L.sleep(1000);
  }
  const proofTail = (performance.now() - t1) / 1000;
  sampling = false; await sampler;

  // Deliver, balance NOT paid.
  for (const id of ids) await L.call(s.base, 'POST', `/api/admin/bookings/${id}/deliver`, { cookie, body: {} });
  // Hashes of every clean file on disk: no client response may ever match one while locked.
  const clean = new Set();
  const dd = new DatabaseSync(s.dbFile, { readOnly: true });
  const rows = dd.prepare('SELECT * FROM photos').all(); dd.close();
  const h = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  for (const p of rows) for (const f of [p.original, p.web, p.thumb]) clean.add(h(fs.readFileSync(path.join(s.dataDir, 'galleries', String(p.booking_id), f))));

  // 30 clients open their gallery and every thumbnail (6 at a time, like a browser), then try to download.
  s.resetPeak();
  const view = []; let leaks = 0; const forbidden = [];
  await Promise.all(Array.from({ length: 30 }, async (_, c) => {
    const t = tokens[c % tokens.length];
    const g = await L.call(s.base, 'GET', `/api/gallery/${t}`);
    const ps = g.data.photos; view.push(Object.assign({}, g, { data: null }));
    for (let i = 0; i < ps.length; i += 6) {
      const batch = await Promise.all(ps.slice(i, i + 6).map((p) => L.call(s.base, 'GET', `/g/${t}/${p.id}/thumb`)));
      for (const r of batch) { if (r.status === 200 && clean.has(h(r.data))) leaks++; r.data = null; view.push(r); }
    }
    for (const size of ['web', 'original']) { const r = await L.call(s.base, 'GET', `/g/${t}/${ps[0].id}/${size}`); if (r.status === 200 && clean.has(h(r.data))) leaks++; r.data = null; view.push(r); if (size === 'original') forbidden.push(r.status); }
    const z = await L.call(s.base, 'GET', `/g/${t}/all.zip`); forbidden.push(z.status);
  }));
  const rssBrowse = s.peakRss();

  // Balance paid: 15 clients download everything at once.
  for (const t of tokens) await L.call(s.base, 'GET', `/api/dev/pay-balance/${t}`);
  s.resetPeak();
  // Stream each zip and count its bytes (never hold it in the test's own memory).
  const zips = await Promise.all(Array.from({ length: 15 }, async (_, c) => {
    const t = performance.now(); const r = await fetch(`${s.base}/g/${tokens[c % tokens.length]}/all.zip`);
    let bytes = 0; for await (const chunk of r.body) bytes += chunk.length;
    return { status: r.status, ms: performance.now() - t, bytes };
  }));
  const rssZip = s.peakRss();

  const out = {
    scenario: 'gallery', galleries: GALLERIES, photosEach: EACH, testPhotoMB: photoBytes.map((b) => n(b / 1048576)),
    upload: { seconds: n(uploadSecs), perPhoto: L.stats(up), peakFfmpegProcesses: peakFfmpeg, peakRssMB: n(rssUpload / 1048576), proofsStillMakingAfterUploadSeconds: n(proofTail), proofsMissingAtEnd: missing },
    lockedGallery: { requests: L.stats(view), cleanBytesServedWhileLocked: leaks, originalAndZipStatuses: [...new Set(forbidden)], peakRssMB: n(rssBrowse / 1048576) },
    zipAfterPaid: { downloads: L.stats(zips), mbEach: n((zips[0].bytes || 0) / 1048576), peakRssMB: n(rssZip / 1048576) },
    files: s.sizes(),
  };
  s.stop();
  L.save('gallery', out);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });

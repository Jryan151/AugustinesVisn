'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.FFMPEG_PATH = 'none'; // the fallback path (originals everywhere) is what's tested here
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'av-photos-'));
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GALLERY_DIR = path.join(TMP, 'galleries');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const { createApp } = require('../server');
const db = require('../src/db');
const media = require('../src/media');
const galleries = require('../src/galleries');

const JPG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAGAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCtAR06f//Z', 'base64');
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let server; let base; let cookie;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.saveSetting('availability', Object.assign({}, db.DEFAULT_SETTINGS.availability, { evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 0, weeklyCap: 50 }));
  const r = await fetch(base + '/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'test-password' }), headers: { 'Content-Type': 'application/json' } });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(base + p, { method, redirect: 'manual', headers: Object.assign(isBuf ? {} : { 'Content-Type': 'application/json' }, headers), body: body == null ? undefined : isBuf ? body : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch (e) { data = buf; }
  return { status: r.status, data, headers: r.headers };
};
const admin = (m, p, b, h = {}) => call(m, p, b, Object.assign({ Cookie: cookie }, h));

let slotN = 0;
async function bookedClient(over = {}) {
  const av = await call('GET', '/api/availability?package=' + (over.package || 'portrait') + '&days=60');
  const slot = av.data.days.flatMap((d) => d.slots)[slotN++].key;
  const b = await call('POST', '/api/bookings', Object.assign({ package: 'portrait', slot, name: 'Jane Doe', email: 'jane@example.com', agree: true }, over), { 'Idempotency-Key': crypto.randomUUID() });
  await call('GET', b.data.checkoutUrl);
  return db.get('SELECT * FROM bookings WHERE token = ?', [b.data.token]);
}

test('image sizes are read from the file itself', () => {
  const dir = path.join(TMP, 'dims'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jpg'), JPG); fs.writeFileSync(path.join(dir, 'b.png'), png(40, 25));
  assert.deepEqual(media.dimensions(path.join(dir, 'a.jpg')), { width: 8, height: 6 });
  assert.deepEqual(media.dimensions(path.join(dir, 'b.png')), { width: 40, height: 25 });
});

test('client photos: admin only, real images only, private until delivered, then the gallery and download-all work', async () => {
  const b = await bookedClient();
  assert.equal((await call('PUT', `/api/admin/bookings/${b.id}/photos`, JPG)).status, 401, 'not without logging in');
  const fake = await admin('PUT', `/api/admin/bookings/${b.id}/photos`, Buffer.from('<html>not a photo</html>'), { 'X-File-Name': 'x.jpg' });
  assert.equal(fake.status, 415);

  const up1 = await admin('PUT', `/api/admin/bookings/${b.id}/photos`, JPG, { 'X-File-Name': encodeURIComponent('Jane 001.jpg') });
  assert.equal(up1.status, 200);
  assert.deepEqual([up1.data.photo.width, up1.data.photo.height, up1.data.photo.file_name], [8, 6, 'Jane 001.jpg']);
  const up2 = await admin('PUT', `/api/admin/bookings/${b.id}/photos`, png(40, 25), { 'X-File-Name': 'Jane 001.jpg' });
  assert.equal(up2.status, 200);

  assert.equal((await call('GET', '/api/gallery/' + b.token)).status, 404, 'not visible before delivery');
  assert.equal((await call('GET', `/g/${b.token}/${up1.data.photo.id}/original`)).status, 404);

  const d = await admin('POST', `/api/admin/bookings/${b.id}/deliver`, {});
  assert.equal(d.data.booking.status, 'delivered');
  assert.match(d.data.booking.gallery_url, new RegExp(`/gallery/${b.token}$`));

  const g = await call('GET', '/api/gallery/' + b.token);
  assert.equal(g.data.photos.length, 2);
  const orig = await call('GET', `/g/${b.token}/${up1.data.photo.id}/original`);
  assert.equal(orig.status, 200);
  assert.ok(orig.data.equals(JPG), 'the client gets exactly the uploaded file');
  assert.match(orig.headers.get('content-disposition'), /attachment; filename="Jane 001.jpg"/);
  const other = await bookedClient({ email: 'x@example.com' });
  assert.equal((await call('GET', `/g/${other.token}/${up1.data.photo.id}/original`)).status, 404, 'one client can’t reach another’s photo');

  const zip = await call('GET', `/g/${b.token}/all.zip`);
  assert.equal(zip.status, 200);
  const z = zip.data;
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const end = z.length - 22;
  assert.equal(z.readUInt32LE(end), 0x06054b50);
  assert.equal(z.readUInt16LE(end + 10), 2, 'two files in the zip');
  const firstName = z.subarray(30, 30 + z.readUInt16LE(26)).toString();
  assert.equal(firstName, 'Jane 001.jpg');
  assert.equal(zlib.crc32(z.subarray(30 + firstName.length, 30 + firstName.length + JPG.length)), z.readUInt32LE(14));
  assert.match(z.toString('latin1'), /Jane 001 \(2\)\.jpg/, 'same names are kept apart');
});

test('removing a photo can be undone; a day later it is really gone', async () => {
  const b = await bookedClient();
  const up = await admin('PUT', `/api/admin/bookings/${b.id}/photos`, JPG, { 'X-File-Name': 'a.jpg' });
  const id = up.data.photo.id;
  assert.equal((await admin('DELETE', `/api/admin/photos/${id}`)).status, 200);
  assert.equal((await admin('GET', `/api/admin/bookings/${b.id}/photos`)).data.photos.length, 0);
  assert.equal((await admin('POST', `/api/admin/photos/${id}/restore`, {})).status, 200);
  assert.equal((await admin('GET', `/api/admin/bookings/${b.id}/photos`)).data.photos.length, 1);
  await admin('DELETE', `/api/admin/photos/${id}`);
  const file = path.join(galleries.dirFor(b.id), db.get('SELECT original FROM photos WHERE id = ?', [id]).original);
  assert.ok(fs.existsSync(file));
  galleries.purgeDeleted(new Date(Date.now() + 2 * 86400000));
  assert.ok(!fs.existsSync(file));
  assert.equal((await admin('POST', `/api/admin/photos/${id}/restore`, {})).status, 409);
});

test('delivering needs photos or a link', async () => {
  const b = await bookedClient();
  assert.equal((await admin('POST', `/api/admin/bookings/${b.id}/deliver`, {})).status, 400);
  const d = await admin('POST', `/api/admin/bookings/${b.id}/deliver`, { galleryUrl: 'https://pixieset.example/jane' });
  assert.equal(d.data.booking.gallery_url, 'https://pixieset.example/jane');
});

test('site background: uploads show on every public page; first can be changed; removal deletes the files', async () => {
  const a = await admin('PUT', '/api/admin/site/background', png(30, 20));
  const b = await admin('PUT', '/api/admin/site/background', JPG);
  assert.equal(b.data.background.length, 2);
  const [p1, p2] = b.data.background;
  const home = (await call('GET', '/')).data.toString();
  assert.match(home, new RegExp(`class="bg-photo on" data-key="${p1.key}" src="${p1.web}"`), 'the first loads with the page');
  assert.match(home, new RegExp(`data-src="${p2.web}"`), 'the rest wait');
  assert.match((await call('GET', '/book')).data.toString(), /class="bg strong"/, 'form pages get the heavier veil');
  const img = await call('GET', p2.web);
  assert.equal(img.status, 200); assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal((await call('GET', '/media/../booking.sqlite')).status, 404);
  const first = await admin('POST', `/api/admin/site/background/${p2.key}/first`, {});
  assert.equal(first.data.background[0].key, p2.key);
  await admin('DELETE', `/api/admin/site/background/${p2.key}`);
  assert.equal((await call('GET', p2.web)).status, 404);
  assert.ok(a.status === 200);
});

test('package card photo: shown with the package, replaced cleanly', async () => {
  const pkg = db.get("SELECT id FROM packages WHERE slug = 'portrait'");
  const one = await admin('PUT', `/api/admin/packages/${pkg.id}/image`, JPG);
  const two = await admin('PUT', `/api/admin/packages/${pkg.id}/image`, png(12, 9));
  assert.equal((await call('GET', one.data.image.web)).status, 404, 'the replaced photo is deleted');
  const list = await call('GET', '/api/packages');
  const p = list.data.packages.find((x) => x.slug === 'portrait');
  assert.deepEqual(p.image, two.data.image);
  assert.equal(p.image_json, undefined, 'stored file names stay private');
  await admin('DELETE', `/api/admin/packages/${pkg.id}/image`);
  assert.equal((await call('GET', '/api/packages')).data.packages.find((x) => x.slug === 'portrait').image, null);
});

test('clients: grouped by email, counted from bookings, with private notes', async () => {
  const r1 = await bookedClient({ email: 'Repeat@Example.com', name: 'Rae Peat', package: 'couples' });
  await bookedClient({ email: 'repeat@example.com', name: 'Rae Peat', phone: '555-0100' });
  await admin('POST', `/api/admin/bookings/${r1.id}/cancel`, {});
  const list = (await admin('GET', '/api/admin/clients')).data.clients;
  const rae = list.find((c) => c.email === 'repeat@example.com');
  assert.equal(rae.sessions, 1, 'a cancelled booking doesn’t count');
  await bookedClient({ email: 'repeat@example.com', name: 'Rae Peat' });
  const again = (await admin('GET', '/api/admin/clients')).data.clients.find((c) => c.email === 'repeat@example.com');
  assert.equal(again.sessions, 2); assert.equal(again.repeat, true); assert.equal(again.stage, 'upcoming');
  assert.equal(again.totalCents, 45000);
  assert.equal((await admin('PUT', '/api/admin/clients/notes', { email: 'nobody@example.com', notes: 'x' })).status, 404);
  await admin('PUT', '/api/admin/clients/notes', { email: 'repeat@example.com', notes: 'Loves moody edits' });
  assert.equal((await admin('GET', '/api/admin/clients')).data.clients.find((c) => c.email === 'repeat@example.com').notes, 'Loves moody edits');
  assert.equal((await call('GET', '/api/admin/clients')).status, 401);
});

test('photos can be nudged: focus and zoom are checked, saved, and placed by /site.css before any script runs', async () => {
  const pkg = db.get("SELECT id FROM packages WHERE slug = 'couples'");
  assert.equal((await admin('PUT', `/api/admin/packages/${pkg.id}/image/frame`, { fx: 20, fy: 30, zoom: 1.2 })).status, 404, 'no photo yet');
  const img = (await admin('PUT', `/api/admin/packages/${pkg.id}/image`, JPG)).data.image;
  assert.deepEqual([img.fx, img.fy, img.zoom], [50, 50, 1], 'a new photo starts centred');
  assert.equal((await admin('PUT', `/api/admin/packages/${pkg.id}/image/frame`, { fx: 120, fy: 30 })).status, 400);
  assert.equal((await admin('PUT', `/api/admin/packages/${pkg.id}/image/frame`, { fx: 20, fy: 30, zoom: 9 })).status, 400);
  assert.equal((await call('PUT', `/api/admin/packages/${pkg.id}/image/frame`, { fx: 20, fy: 30, zoom: 1.2 })).status, 401);
  const saved = await admin('PUT', `/api/admin/packages/${pkg.id}/image/frame`, { fx: 20, fy: 30, zoom: 1.2 });
  assert.deepEqual([saved.data.image.fx, saved.data.image.fy, saved.data.image.zoom], [20, 30, 1.2]);

  const bg = (await admin('PUT', '/api/admin/site/background', JPG)).data.background.pop();
  await admin('PUT', `/api/admin/site/background/${bg.key}/frame`, { fx: 70, fy: 10, zoom: 1 });

  const css = (await call('GET', '/site.css')).data.toString();
  assert.match(css, new RegExp(`img\\[data-key="${img.key}"\\]\\{object-position:20% 30%;--fx:20%;--fy:30%;--zoom:1.2\\}`));
  assert.match(css, new RegExp(`img\\[data-key="${bg.key}"\\]\\{object-position:70% 10%`));
  const home = (await call('GET', '/')).data.toString();
  const stamp = /href="\/site\.css\?v=([0-9a-f]{10})"/.exec(home);
  assert.ok(stamp, 'pages link the framing stylesheet');
  assert.match(home, new RegExp(`data-key="${bg.key}"`), 'background photos carry their key');
  await admin('PUT', `/api/admin/site/background/${bg.key}/frame`, { fx: 71, fy: 10, zoom: 1 });
  const again = /href="\/site\.css\?v=([0-9a-f]{10})"/.exec((await call('GET', '/')).data.toString());
  assert.notEqual(again[1], stamp[1], 'a nudge changes the stamp, so it shows at once');
});

test('the name comes from one setting, on every page', async () => {
  for (const p of ['/', '/book', '/admin']) {
    const html = (await call('GET', p)).data.toString();
    assert.ok(!html.includes('{{BRAND}}'), p);
    assert.match(html, /Augustines.Visn/, p);
  }
});

'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const db = require('../src/db');

let server; let base; let cookie;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  // Two background photos already uploaded (as stored by sitemedia).
  db.saveSetting('siteBackground', { photos: ['a', 'b'].map((n) => ({ name: n, original: n + '.jpg', web: n + '-web.jpg', thumb: n + '-t.jpg', width: 2000, height: 1333 })) });
});
test.after(() => server.close());
const put = (body) => fetch(base + '/api/admin/site/admin-background', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
const adminPage = () => fetch(base + '/admin').then((r) => r.text());

test('behind Admin: the site\'s photos by default, one photo still, or off', async () => {
  let html = await adminPage();
  assert.match(html, /class="bg strong admin"/, 'same as the site by default');
  assert.equal((html.match(/class="bg-photo/g) || []).length, 2);

  const one = await put({ mode: 'photo', key: 'b' });
  assert.equal(one.status, 200);
  assert.match(one.data.markup, /data-key="b"/);
  html = await adminPage();
  assert.equal((html.match(/class="bg-photo/g) || []).length, 1, 'one photo, still');
  assert.match(html, /\/media\/b-web\.jpg/);

  assert.equal((await put({ mode: 'off' })).status, 200);
  assert.doesNotMatch(await adminPage(), /class="bg /, 'off: plain, as before');
});

test('a removed photo falls back to the site\'s photos; bad choices are refused; only the admin can change it', async () => {
  await put({ mode: 'photo', key: 'a' });
  db.saveSetting('siteBackground', { photos: db.setting('siteBackground').photos.filter((p) => p.name !== 'a') });
  assert.match(await adminPage(), /class="bg strong admin"/);
  assert.match(await adminPage(), /data-key="b"/);
  assert.equal((await put({ mode: 'photo', key: 'nope' })).status, 400);
  assert.equal((await put({ mode: 'video' })).status, 400);
  const anon = await fetch(base + '/api/admin/site/admin-background', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'off' }) });
  assert.equal(anon.status, 401);
  assert.doesNotMatch(await fetch(base + '/').then((r) => r.text()), /bg strong admin/, 'the public pages are unchanged');
});

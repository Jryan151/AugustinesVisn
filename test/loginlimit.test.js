'use strict';
// The Admin wrong-password limit can't be dodged by sending a made-up address.
// TRUST_PROXY=1 is the production setting (install.sh); these requests come from 127.0.0.1, standing in for nginx.
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.TRUST_PROXY = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const auth = require('../src/auth');

let server; let base;
test.before(async () => {
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => auth._resetFails());

const login = (password, headers = {}) => fetch(base + '/api/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password }),
}).then((r) => r.status);

test('5 wrong passwords lock the login, even for the right one', async () => {
  for (let i = 0; i < 5; i++) assert.equal(await login('nope'), 401);
  assert.equal(await login('test-password'), 429);
});

test('a made-up CF-Connecting-IP or X-Forwarded-For start gets no extra tries', async () => {
  // What an attacker reaching the server directly sends; nginx appends the address it really saw (203.0.113.9).
  for (let i = 0; i < 5; i++) {
    assert.equal(await login('nope', { 'CF-Connecting-IP': `10.0.0.${i}`, 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` }), 401);
  }
  assert.equal(await login('test-password', { 'CF-Connecting-IP': '10.9.9.9', 'X-Forwarded-For': '10.9.9.9, 203.0.113.9' }), 429);
});

test('each real visitor (X-Real-IP from nginx) has their own count', async () => {
  for (let i = 0; i < 5; i++) await login('nope', { 'X-Real-IP': '198.51.100.1' });
  assert.equal(await login('test-password', { 'X-Real-IP': '198.51.100.1' }), 429);
  assert.equal(await login('test-password', { 'X-Real-IP': '198.51.100.2' }), 200);
});

test('30 wrong passwords from many addresses lock the login for everyone for a while', async () => {
  for (let i = 0; i < 30; i++) await login('nope', { 'X-Real-IP': `198.51.100.${i + 10}` });
  assert.equal(await login('test-password', { 'X-Real-IP': '192.0.2.200' }), 429);
});

test('only nginx on this machine may name the address; headers from anywhere else are ignored', () => {
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  assert.equal(auth.clientIp(req('127.0.0.1', { 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(auth.clientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 198.51.100.8' })), '198.51.100.8');
  assert.equal(auth.clientIp(req('203.0.113.5', { 'x-real-ip': '198.51.100.7', 'cf-connecting-ip': '1.2.3.4' })), '203.0.113.5');
  assert.equal(auth.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), '127.0.0.1');
});

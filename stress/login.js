'use strict';
/* stress/login.js — does the 5-tries-per-10-minutes password limit hold behind nginx (TRUST_PROXY=1, as install.sh sets)? */
const L = require('./lib');

(async () => {
  process.env.TRUST_PROXY = '1';
  const s = await L.startServer();
  const tryAs = (headers) => L.call(s.base, 'POST', '/api/admin/login', { body: { password: 'wrong' }, headers });
  // Same visitor, honest header: the limit should kick in after 5.
  const same = []; for (let i = 0; i < 8; i++) same.push((await tryAs({ 'X-Forwarded-For': '203.0.113.7' })).status);
  // Same visitor, but making up a different address in the header each time (nginx appends the real one after it).
  const spoofed = []; for (let i = 0; i < 200; i++) spoofed.push((await tryAs({ 'X-Forwarded-For': `198.51.100.${i % 250}, 203.0.113.8` })).status);
  const cf = []; for (let i = 0; i < 50; i++) cf.push((await tryAs({ 'CF-Connecting-IP': `192.0.2.${i}` })).status);
  const tally = (a) => a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  const out = { scenario: 'login', trustProxy: true, sameAddress: same, spoofedForwardedFor: tally(spoofed), spoofedCfConnectingIp: tally(cf) };
  s.stop(); L.save('login', out); console.log(JSON.stringify(out));
})();

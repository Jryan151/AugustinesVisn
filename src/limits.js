'use strict';
/* =====================================================================
   limits.js — who a visitor really is, and how often they can use the public forms.

   Without limits, one script can make the site email a stranger list from your domain, or hold every open time with
   made-up names. These caps sit far above what a real client ever does (one booking, a typo or two), so they only
   ever stop scripts:
     bookings      10 tries an hour per connection   (holds and in-person code requests)
     codes          5 code emails an hour per connection
     requests       5 "request another time" an hour per connection
     holds          5 holds a day per connection (a Zelle hold lasts a day, so an hourly cap alone wouldn't stop a
                    patient script; a real client books once, maybe twice after leaving checkout)
     open holds     2 unpaid holds at once per email address (bookings.js)
   They're kept in memory: a restart clears them, which is fine for limits measured in minutes.

   The visitor's address. Behind nginx every request comes from 127.0.0.1, so the real address is in
   X-Forwarded-For. A visitor can put anything at the *front* of that header; nginx adds the address it actually saw at
   the *end*, so only the last one is trusted. Behind Cloudflare, that last address is Cloudflare's, and Cloudflare
   names the visitor in CF-Connecting-IP; that header is believed only when the request really came from Cloudflare.
   ===================================================================== */
const net = require('net');
const config = require('./config');

/* ---------- the visitor's address ---------- */
// Cloudflare's published ranges (cloudflare.com/ips). If they ever add one, visitors through it share a limit; nothing breaks.
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'];
const cfList = new net.BlockList();
for (const r of CLOUDFLARE) { const [a, bits] = r.split('/'); cfList.addSubnet(a, Number(bits), net.isIPv6(a) ? 'ipv6' : 'ipv4'); }

const plain = (ip) => String(ip || '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
function isCloudflare(ip) {
  ip = plain(ip);
  const kind = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return !!kind && cfList.check(ip, kind);
}

function clientIp(req) {
  const peer = plain(req.socket && req.socket.remoteAddress);
  if (!config.trustProxy) return peer;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(plain).filter((x) => net.isIP(x));
  let ip = hops.length ? hops[hops.length - 1] : peer;
  const cf = plain(req.headers['cf-connecting-ip']);
  if (isCloudflare(ip) && net.isIP(cf)) ip = cf;
  return ip;
}

/* ---------- counting ---------- */
/** A sliding-window counter: at most `max` hits per `windowMs` for each key. */
function limiter(max, windowMs) {
  const hits = new Map(); // key → [times]
  const recent = (k, now) => (hits.get(k) || []).filter((t) => t > now - windowMs);
  function prune(now) { for (const [k, v] of hits) { const r = v.filter((t) => t > now - windowMs); if (r.length) hits.set(k, r); else hits.delete(k); } }
  return {
    max, windowMs,
    /** How many hits this key has in the window. */
    count: (k, now = Date.now()) => recent(k, now).length,
    /** Records a hit. False (and not recorded) if the key is already at the limit. */
    hit(k, now = Date.now()) {
      const r = recent(k, now);
      if (r.length >= max) return false;
      r.push(now); hits.set(k, r);
      if (hits.size > 5000) prune(now); // a flood of made-up keys can't grow memory without end
      return true;
    },
    clear: (k) => hits.delete(k),
    reset: () => hits.clear(),
    size: () => hits.size,
  };
}

const HOUR = 3600000;
const perIp = {
  bookings: limiter(10, HOUR),
  codes: limiter(5, HOUR),
  requests: limiter(5, HOUR),
  holds: limiter(5, 24 * HOUR),
};

/* Tests make hundreds of bookings from one address, so the form caps are off there unless a test turns them on. */
const state = { enforce: !config.isTest };

/** Throws a 429 when this visitor has used `kind` too often; otherwise counts this use. */
function check(kind, req, message) {
  if (!state.enforce) return;
  if (!perIp[kind].hit(clientIp(req))) {
    const { HttpError } = require('./http');
    throw new HttpError(429, message || 'Too many tries from this connection. Wait an hour, or email to book.');
  }
}

/** For caps that only count what actually happened (a hold made, not a try at a taken time). */
function full(kind, req) { return state.enforce && perIp[kind].count(clientIp(req)) >= perIp[kind].max; }
function record(kind, req) { if (state.enforce) perIp[kind].hit(clientIp(req)); }

module.exports = { full, record, clientIp, isCloudflare, limiter, perIp, check, state, MAX_OPEN_HOLDS_PER_EMAIL: 2 };

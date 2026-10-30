'use strict';
/* =====================================================================
   http.js — the small web layer: routes, JSON bodies, cookies, static files and security headers.

   Built on Node's own http module, so nothing to install. A route is (method, path pattern, handler); ":name" in a
   pattern becomes req.params.name. A handler returns nothing (it answered itself with res.json / res.send) or throws
   an HttpError, which becomes a JSON error with that status.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'inline-speculation-rules'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "connect-src 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Reads the request body (up to `limit` bytes). Keeps the raw text: Stripe's signature is checked against it. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decorate(res) {
  res.json = (status, body) => {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  res.send = (status, text, type = 'text/plain; charset=utf-8') => {
    if (res.headersSent) return;
    res.statusCode = status; res.setHeader('Content-Type', type); res.end(text);
  };
  res.redirect = (to) => { res.statusCode = 303; res.setHeader('Location', to); res.end(); };
}

function compile(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  return { re, names };
}

function createRouter() {
  const routes = [];
  const router = {
    add(method, pattern, handler, opts = {}) { routes.push(Object.assign({ method, handler }, compile(pattern), opts)); return router; },
    get: (p, h, o) => router.add('GET', p, h, o),
    post: (p, h, o) => router.add('POST', p, h, o),
    put: (p, h, o) => router.add('PUT', p, h, o),
    patch: (p, h, o) => router.add('PATCH', p, h, o),
    delete: (p, h, o) => router.add('DELETE', p, h, o),
    /** Finds and runs the route. Returns false when nothing matched (so static files can try). */
    async handle(req, res) {
      const url = new URL(req.url, 'http://local');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        req.params = {}; r.names.forEach((n, i) => { req.params[n] = decodeURIComponent(m[i + 1]); });
        req.query = Object.fromEntries(url.searchParams);
        req.cookies = parseCookies(req);
        if (r.stream) req.body = {}; // the handler reads the upload itself, straight to disk
        else if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.rawBody = await readBody(req, r.bodyLimit);
          if (!r.raw) {
            try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; } catch (e) { throw new HttpError(400, 'That request wasn’t valid JSON.'); }
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Send a JSON object.');
          }
        } else req.body = {};
        await r.handler(req, res);
        return true;
      }
      return false;
    },
  };
  return router;
}

/** Serves files from `dir`. HTML is never cached (so changes show at once); CSS and JS for an hour; media for 30 days. */
function serveStatic(dir, req, res, rewrites) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  for (const [re, to] of rewrites) if (re.test(pathname)) { pathname = to; break; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(dir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dir + path.sep)) return false;
  let st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : /\.(mp4|webm|jpg|jpeg|png|webp)$/.test(ext) ? 'public, max-age=2592000' : 'public, max-age=3600');
  // Video needs byte ranges, or Safari won't play it.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); res.end(); return true; }
    res.statusCode = 206;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.setHeader('Content-Length', st.size);
  if (ext === '.mp4' || ext === '.webm') res.setHeader('Accept-Ranges', 'bytes');
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { HttpError, createRouter, serveStatic, securityHeaders, decorate, parseCookies };

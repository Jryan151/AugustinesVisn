/* =====================================================================
   common.js — small helpers every page uses. Loaded first; puts one object, AV, on window.

     AV.api(path, opts)        fetch JSON; throws an Error with .status and .data on a bad answer
     AV.money(cents)           "$225" or "$75.50"
     AV.time(iso) / AV.day(ymd)  times and dates in the business's time zone
     AV.toast(text, opts)      a short message at the bottom, optionally with an action (Undo)
     AV.cached(key, url, fn)   show the last copy at once, then the fresh one (only for things that may be a bit old)
     AV.slow(ms, show)         run show() only if the work takes longer than ms (skeletons that never flash)
     AV.transition(fn)         change the page inside a short view transition, when motion is welcome
     AV.startBackground()      the background photos fade from one to the next (starts by itself on each page)
   ===================================================================== */
(function () {
  'use strict';
  const TZ_DEFAULT = 'America/Phoenix';
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}), credentials: 'same-origin' };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(path, init); } catch (e) {
      const err = new Error('You seem to be offline. Check your connection and try again.'); err.status = 0; throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'Something went wrong. Try again.'); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  const money = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  let tz = TZ_DEFAULT;
  const setTimezone = (z) => { if (z) tz = z; };
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const day = (ymd, opts) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }, opts));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- toast ---------- */
  let toastEl, toastTimer;
  function toast(text, { actionLabel, onAction, error = false, ms = 6000 } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.classList.toggle('error', error);
    toastEl.innerHTML = `<span>${esc(text)}</span>`;
    if (actionLabel) {
      const b = document.createElement('button');
      b.className = 'btn btn-small'; b.textContent = actionLabel;
      b.addEventListener('click', () => { toastEl.hidden = true; clearTimeout(toastTimer); onAction(); });
      toastEl.appendChild(b);
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  /* ---------- show the last copy, then the fresh one ----------
     For things where an old copy is harmless (the package list). Never used for times or anything at checkout. */
  function cached(key, url, render) {
    let have = false;
    try { const c = sessionStorage.getItem('av:' + key); if (c) { render(JSON.parse(c), true); have = true; } } catch (e) { /* storage off */ }
    const refresh = () => api(url).then((d) => {
      try { sessionStorage.setItem('av:' + key, JSON.stringify(d)); } catch (e) { /* storage full or off */ }
      render(d, false);
    }).catch((e) => { if (!have) render(null, false, e); });
    refresh();
    addEventListener('focus', refresh);
    addEventListener('online', refresh);
    return have;
  }

  function slow(ms, show) {
    const t = setTimeout(show, ms);
    return () => clearTimeout(t);
  }

  function transition(fn) {
    if (!document.startViewTransition || reduceMotion()) { fn(); return; }
    document.startViewTransition(fn);
  }

  /* ---------- the background photos ----------
     The first photo comes with the page. Once the page has loaded and gone quiet, the next one is fetched, and each
     fades in over the last every HOLD ms while it slowly drifts (CSS). With "reduce motion", data saver or slow data,
     the first photo stays, still. It pauses while the tab is hidden. */
  const HOLD = 7000;
  function startBackground(root = document) {
    const photos = [...root.querySelectorAll('.bg-photo')];
    if (photos.length < 2) return;
    const c = navigator.connection || {};
    if (reduceMotion() || c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || '')) return;
    let i = 0; let timer = null;
    const load = (img) => new Promise((ok) => {
      if (!img.dataset.src) return ok();
      img.addEventListener('load', ok, { once: true }); img.addEventListener('error', ok, { once: true });
      img.src = img.dataset.src; delete img.dataset.src;
    });
    const next = async () => {
      const n = (i + 1) % photos.length;
      await load(photos[n]);
      if (!photos[n].complete || !photos[n].naturalWidth) { i = n; return schedule(); } // skip one that won't load
      photos[n].classList.add('on'); photos[i].classList.remove('on');
      i = n;
      schedule();
    };
    const schedule = () => { clearTimeout(timer); if (!document.hidden) timer = setTimeout(next, HOLD); };
    const idle = () => (window.requestIdleCallback || ((f) => setTimeout(f, 1)))(() => { load(photos[1]); schedule(); }, { timeout: 4000 });
    if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
    document.addEventListener('visibilitychange', () => (document.hidden ? clearTimeout(timer) : schedule()));
  }
  // Every page with a background starts it by itself.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => startBackground());
  else startBackground();

  /* ---------- paying by Zelle ----------
     The same panel on the booking page (deposit) and in the gallery (balance): who to pay, the exact amount and the
     memo reference, each with a copy button, the QR code if there is one, and "I've sent it". */
  function zellePanel({ zelle, amountCents, ref, sent, what }) {
    const row = (label, value, copy) => `<div class="z-row"><dt>${label}</dt><dd><span class="num">${esc(value)}</span>${copy ? `<button type="button" class="btn btn-small z-copy" data-copy="${esc(copy)}">Copy</button>` : ''}</dd></div>`;
    return `<div class="zelle">
      <div class="z-main">
        <ol class="z-steps">
          <li>Open your bank app and choose <b>Zelle</b>.</li>
          <li>Send <b class="num">${money(amountCents)}</b> to the details below${zelle.qr ? ', or scan the code' : ''}.</li>
          <li>Put <b>${esc(ref)}</b> in the memo, so it’s matched to you.</li>
        </ol>
        <dl class="z-details">
          ${row('To', zelle.recipient, zelle.recipient)}
          ${zelle.name ? row('Name', zelle.name) : ''}
          ${row('Amount', money(amountCents), (amountCents / 100).toFixed(2))}
          ${row('Memo', ref, ref)}
        </dl>
      </div>
      ${zelle.qr ? `<img class="z-qr" src="${esc(zelle.qr.url)}" width="${zelle.qr.width}" height="${zelle.qr.height}" alt="Zelle QR code: scan it in your bank app">` : ''}
      <div class="z-foot">${sent
        ? `<p class="z-sent">Thanks, we’re checking for it. You’ll get an email as soon as it’s confirmed${what === 'balance' ? ' and your photos unlock' : ''}.</p>`
        : '<button type="button" class="btn btn-primary" data-zelle-sent>I’ve sent it</button>'}</div>
    </div>`;
  }
  // Copy buttons anywhere on the page.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied.'); } catch (err) { toast('Couldn’t copy. Select it and copy instead.', { error: true }); }
  });

  window.AV = { zellePanel, api, money, time, day, esc, toast, cached, slow, transition, startBackground, setTimezone, reduceMotion };
})();

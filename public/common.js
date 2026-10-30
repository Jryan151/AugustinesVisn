/* =====================================================================
   common.js — small helpers every page uses. Loaded first; puts one object, AV, on window.

     AV.api(path, opts)        fetch JSON; throws an Error with .status and .data on a bad answer
     AV.money(cents)           "$225" or "$75.50"
     AV.time(iso) / AV.day(ymd)  times and dates in the business's time zone
     AV.toast(text, opts)      a short message at the bottom, optionally with an action (Undo)
     AV.cached(key, url, fn)   show the last copy at once, then the fresh one (only for things that may be a bit old)
     AV.slow(ms, show)         run show() only if the work takes longer than ms (skeletons that never flash)
     AV.transition(fn)         change the page inside a short view transition, when motion is welcome
     AV.startBackground()      fade in the background video once the page has settled
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

  /* ---------- background video ----------
     The still shows at once. The clip loads only after the page has finished and gone quiet, picks the phone or
     big-screen file, and fades in once it's actually playing. Never with "reduce motion", data saver or slow data. */
  function startBackground(root = document) {
    const v = root.querySelector('.bg-video');
    if (!v) return;
    const c = navigator.connection || {};
    if (reduceMotion() || c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || '')) return;
    const go = () => {
      const big = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 1600 && window.innerWidth >= 768;
      v.muted = true; v.defaultMuted = true;
      v.src = big ? v.dataset.lg : v.dataset.sm;
      v.addEventListener('playing', () => v.classList.add('on'), { once: true });
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    };
    const idle = () => (window.requestIdleCallback || ((f) => setTimeout(f, 1)))(() => setTimeout(go, 1500), { timeout: 4000 });
    if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
    document.addEventListener('visibilitychange', () => {
      if (!v.src) return;
      if (document.hidden) v.pause(); else { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    });
  }

  window.AV = { api, money, time, day, esc, toast, cached, slow, transition, startBackground, setTimezone, reduceMotion };
})();

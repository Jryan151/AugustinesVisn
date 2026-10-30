/* =====================================================================
   book.js — the three booking steps: package → time → details & deposit.

   - The step lives in the address (?p=slug&step=2), so Back and Forward work and a link can open any step.
   - Times are always fetched fresh (never from a cache): a time someone else took must never look free.
   - The "Pay deposit" request carries an Idempotency-Key made when the details step opens. A double tap or a retry
     after a dropped connection gets the same booking back, never a second one. The button is off while it runs.
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money, time, day, toast, slow, transition } = AV;
  const $ = (id) => document.getElementById(id);
  const WEEKS = 6;

  const state = { packages: [], pkg: null, from: null, days: [], date: null, slot: null, key: null, terms: '' };

  /* ---------- steps and the address ---------- */
  function show(step, push = true) {
    if (step > 1 && !state.pkg) step = 1;
    if (step > 2 && !state.slot) step = 2;
    (push ? transition : (fn) => fn())(() => {
      for (const n of [1, 2, 3]) $('step-' + n).hidden = n !== step;
      document.querySelectorAll('.progress li').forEach((li) => {
        const n = Number(li.dataset.step);
        if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
        li.classList.toggle('done', n < step);
      });
    });
    if (push) {
      const q = new URLSearchParams();
      if (state.pkg) q.set('p', state.pkg.slug);
      if (step > 1) q.set('step', step);
      history.pushState({ step }, '', '/book' + (q.toString() ? '?' + q : ''));
    }
    if (step === 2 && !state.days.length) loadDays(true);
    if (step === 3) enterDetails();
    window.scrollTo({ top: 0 });
  }
  addEventListener('popstate', (e) => show((e.state && e.state.step) || 1, false));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => history.back()));

  /* ---------- background: the chosen package's photo replaces the site's, behind a strong veil so forms stay calm ---------- */
  function setBackground(p) {
    const host = $('bg');
    if (!p || !p.image) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="bg strong" aria-hidden="true"><img class="bg-photo on" src="${esc(p.image.web)}" alt="" decoding="async"><div class="bg-veil"></div></div>`;
  }

  /* ---------- step 1: package ---------- */
  function renderPackages() {
    const box = $('package-choices');
    box.removeAttribute('aria-busy');
    box.innerHTML = state.packages.map((p) => `<button type="button" class="choice" data-slug="${esc(p.slug)}" aria-pressed="${state.pkg && state.pkg.slug === p.slug}">
      <span>${esc(p.name)}<small class="num">${p.minutes} min · ${p.photos} edited photos · ready in ${p.turnaround_days} days</small></span>
      <span class="price">${money(p.price_cents)}</span></button>`).join('') || '<p class="empty">No packages are open for booking right now.</p>';
    box.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => pickPackage(b.dataset.slug)));
  }
  function pickPackage(slug) {
    const p = state.packages.find((x) => x.slug === slug);
    if (!p) return;
    if (!state.pkg || state.pkg.slug !== p.slug) { state.days = []; state.date = null; state.slot = null; state.key = null; }
    state.pkg = p;
    setBackground(p);
    renderPackages();
    show(2);
  }

  /* ---------- step 2: time ---------- */
  async function loadDays(reset) {
    const daysBox = $('days');
    if (reset) { state.days = []; state.from = null; state.date = null; $('slots').innerHTML = ''; }
    $('more-days').hidden = true;
    const stopSkeleton = slow(300, () => {
      if (!state.days.length) daysBox.innerHTML = '<div class="cal">' + Array.from({ length: 35 }, () => '<span class="choice day skeleton"><b>00</b></span>').join('') + '</div>';
    });
    try {
      const q = new URLSearchParams({ package: state.pkg.slug, days: String(WEEKS * 7) });
      if (state.from) q.set('from', state.from);
      const data = await api('/api/availability?' + q);
      AV.setTimezone(data.timezone);
      state.days = state.days.concat(data.days);
      const last = data.days[data.days.length - 1];
      const next = new Date(last.date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      state.from = next.toISOString().slice(0, 10);
      $('more-days').hidden = data.days.length < WEEKS * 7;
    } catch (e) {
      daysBox.innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
      stopSkeleton();
      return;
    }
    stopSkeleton();
    renderDays();
  }
  $('more-days').addEventListener('click', () => loadDays(false));

  // A real calendar: Monday to Sunday columns, open days as buttons, the rest dimmed.
  function renderDays() {
    if (!state.days.some((d) => d.slots.length)) {
      $('days').innerHTML = '<p class="empty">No open times in these weeks. Try later dates, or email to ask about a custom time.</p>';
      return;
    }
    const first = state.days[0].date;
    const lead = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
    const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span class="cal-head" aria-hidden="true">${d}</span>`).join('');
    const blanks = '<span></span>'.repeat(lead);
    const cells = state.days.map((d, i) => {
      const n = Number(d.date.slice(8));
      const month = n === 1 || i === 0 ? `<small>${day(d.date, { weekday: undefined, day: undefined })}</small>` : '';
      const label = day(d.date, { weekday: 'long', month: 'long' });
      if (!d.slots.length) return `<span class="day off" aria-hidden="true"><b>${n}</b>${month}</span>`;
      return `<button type="button" class="choice day" data-date="${d.date}" aria-label="${label}" aria-pressed="${state.date === d.date}"><b>${n}</b>${month}</button>`;
    }).join('');
    $('days').innerHTML = `<div class="cal">${head}${blanks}${cells}</div>`;
    $('days').querySelectorAll('button.day').forEach((b) => b.addEventListener('click', () => pickDate(b.dataset.date)));
    if (state.date) renderSlots();
  }
  function pickDate(date) {
    state.date = date;
    $('days').querySelectorAll('button.day').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === date)));
    renderSlots();
    $('slots').scrollIntoView({ block: 'nearest', behavior: AV.reduceMotion() ? 'auto' : 'smooth' });
  }
  function renderSlots() {
    const d = state.days.find((x) => x.date === state.date);
    const label = { morning: 'Sunrise', evening: 'Sunset' };
    $('slots').innerHTML = !d ? '' : `<h3>${day(d.date, { weekday: 'long', month: 'long' })}</h3>` + d.slots.map((s) => `
      <button type="button" class="choice" data-key="${s.key}" aria-pressed="${state.slot && state.slot.key === s.key}">
        <span>${label[s.period]}<small>${s.period === 'morning' ? 'Soft, cool light and empty streets' : 'Warm light, long shadows'}</small></span>
        <span class="num"><time datetime="${s.start}">${time(s.start)}</time> – <time datetime="${s.end}">${time(s.end)}</time></span>
      </button>`).join('');
    $('slots').querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
      const slot = d.slots.find((s) => s.key === b.dataset.key);
      if (!state.slot || state.slot.key !== slot.key) state.key = null; // a different time is a different request
      state.slot = slot;
      show(3);
    }));
  }

  /* ---------- step 3: details and deposit ---------- */
  function enterDetails() {
    const p = state.pkg; const s = state.slot;
    if (!state.key) state.key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    $('summary').innerHTML = `
      <div><dt>Package</dt><dd>${esc(p.name)}</dd></div>
      <div><dt>When</dt><dd>${day(state.date, { weekday: 'long', month: 'long' })}, <time datetime="${s.start}">${time(s.start)}</time>–<time datetime="${s.end}">${time(s.end)}</time></dd></div>
      <div><dt>Deposit today</dt><dd class="price">${money(p.deposit_cents)}</dd></div>
      <div><dt>Balance at the shoot</dt><dd class="price">${money(p.price_cents - p.deposit_cents)}</dd></div>`;
    $('terms').textContent = state.terms;
    $('pay').textContent = `Pay ${money(p.deposit_cents)} deposit`;
    $('form-error').hidden = true;
  }

  function fieldError(msg, field) {
    const box = $('form-error');
    box.textContent = msg; box.hidden = false;
    if (field && $(field)) $(field).focus();
  }

  $('details').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('pay');
    if (btn.getAttribute('aria-busy') === 'true') return;
    const f = e.target;
    if (f.name.value.trim().length < 2) return fieldError('Add your name.', 'name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value.trim())) return fieldError('Check your email address.', 'email');
    if (!f.agree.checked) return fieldError('Please agree to the booking terms.', 'agree');
    $('form-error').hidden = true;
    btn.setAttribute('aria-busy', 'true');
    const label = btn.textContent; btn.textContent = 'Holding your time…';
    try {
      const out = await api('/api/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': state.key },
        body: { package: state.pkg.slug, slot: state.slot.key, name: f.name.value, email: f.email.value, phone: f.phone.value, notes: f.notes.value, agree: true },
      });
      location.assign(out.checkoutUrl); // the button stays off while the browser leaves
      return;
    } catch (err) {
      btn.removeAttribute('aria-busy'); btn.textContent = label;
      if (err.data && err.data.code === 'slot_taken') {
        state.slot = null; state.key = null;
        toast(err.message, { error: true });
        await loadDays(true);
        show(2);
        return;
      }
      if (err.status >= 400 && err.status < 500) state.key = null; // a refused request can be fixed and sent again as new
      fieldError(err.message, err.data && err.data.field);
    }
  });

  /* ---------- start ---------- */
  async function start() {
    const q = new URLSearchParams(location.search);
    // Back from Stripe without paying: let the time go straight away, so it (or another) can be picked again.
    if (q.get('released')) {
      api(`/api/bookings/${encodeURIComponent(q.get('released'))}/release`, { method: 'POST', body: {} }).catch(() => {});
      toast('Payment cancelled. Nothing was charged.');
      q.delete('released');
    }
    // The package skeleton is already in the page; CSS shows it only if this takes longer than 300 ms.
    try {
      const [pk, site] = await Promise.all([api('/api/packages'), api('/api/site')]);
      state.packages = pk.packages; state.terms = site.terms;
    } catch (e) {
      $('package-choices').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
      $('step-1').hidden = false;
      return;
    }
    renderPackages();
    const pre = state.packages.find((p) => p.slug === q.get('p'));
    if (pre) { state.pkg = pre; setBackground(pre); renderPackages(); }
    const step = pre ? 2 : 1;
    history.replaceState({ step }, '', '/book' + (pre ? '?p=' + encodeURIComponent(pre.slug) + (step > 1 ? '&step=2' : '') : ''));
    show(step, false);
  }
  start();
})();

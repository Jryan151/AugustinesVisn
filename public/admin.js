/* =====================================================================
   admin.js — the photographer's side: the bookings pipeline, availability, packages.

   Moves happen at once, with an Undo toast instead of "Are you sure?":
   - Mark shot / Start editing: Undo just moves it back.
   - Deliver and Cancel email the client, so that email waits 10 seconds; Undo pulls it back before it leaves.
   The board refreshes when the window comes back into focus.
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money, toast } = AV;
  const $ = (id) => document.getElementById(id);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const COLUMNS = [
    ['needs_refund', 'Needs attention'],
    ['booked', 'Booked'],
    ['prepped', 'Prepped'],
    ['shot', 'Shot'],
    ['editing', 'Editing'],
    ['delivered', 'Delivered'],
  ];
  const PREP_LABELS = { location: 'Location', look: 'Look', who: 'Who / what', references: 'References', other: 'Other' };
  let bookings = [];

  /* ---------- login ---------- */
  async function boot() {
    const me = await api('/api/admin/me').catch(() => ({ admin: false }));
    $('login').hidden = me.admin; $('app').hidden = !me.admin; $('logout').hidden = !me.admin;
    if (me.admin) { loadBoard(); loadSettings(); } else $('password').focus();
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } }); $('password').value = ''; $('login-error').hidden = true; boot(); }
    catch (err) { $('login-error').textContent = err.message; $('login-error').hidden = false; }
  });
  $('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); boot(); });
  function handle(err) {
    if (err.status === 401) { boot(); return; }
    toast(err.message, { error: true });
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const name of ['pipeline', 'settings', 'packages']) $('tab-' + name).hidden = name !== t.dataset.tab;
  }));

  /* ---------- the board ---------- */
  async function loadBoard() {
    try { bookings = (await api('/api/admin/bookings')).bookings; renderBoard(); } catch (e) { handle(e); }
  }
  addEventListener('focus', () => { if (!$('app').hidden) loadBoard(); });

  function renderBoard() {
    const recent = Date.now() - 30 * 86400000;
    $('board').innerHTML = COLUMNS.map(([status, title]) => {
      let items = bookings.filter((b) => b.status === status);
      if (status === 'delivered') items = items.filter((b) => new Date(b.delivered_at) > recent).reverse();
      if (status === 'needs_refund' && !items.length) return '';
      return `<div class="col"><h3><span>${title}</span><span class="num">${items.length}</span></h3>
        ${items.map(card).join('') || '<p class="muted">Nothing here.</p>'}</div>`;
    }).join('');
  }

  function card(b) {
    const prep = b.prep ? Object.entries(PREP_LABELS).filter(([k]) => b.prep[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(b.prep[k])}</dd>`).join('') : '';
    let actions = '';
    if (b.status === 'booked' || b.status === 'prepped') actions = btn('status', b, 'Mark shot', 'shot') + btn('cancel', b, 'Cancel');
    if (b.status === 'shot') actions = btn('status', b, 'Start editing', 'editing') + btn('deliver-open', b, 'Deliver…');
    if (b.status === 'editing') actions = btn('deliver-open', b, 'Deliver…');
    if (b.status === 'delivered') actions = `<a class="btn btn-small" href="${esc(b.gallery_url)}" target="_blank" rel="noopener">Gallery</a>`;
    if (b.status === 'needs_refund') actions = '<p class="meta">Paid after the time was taken. Refund the deposit in Stripe, then email them a new date.</p>';
    return `<article class="card${b.status === 'needs_refund' ? ' attention' : ''}" data-id="${b.id}">
      <h4>${esc(b.client_name)}</h4>
      <div class="meta">${esc(b.package_name)} · ${esc(b.when)}</div>
      <div class="meta num">Deposit ${money(b.deposit_cents)} · balance ${money(b.price_cents - b.deposit_cents)}</div>
      <details><summary>Details${b.prep ? ' and shoot plan' : ''}</summary><dl>
        <dt>Email</dt><dd><a href="mailto:${esc(b.client_email)}">${esc(b.client_email)}</a></dd>
        ${b.client_phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.client_phone)}">${esc(b.client_phone)}</a></dd>` : ''}
        ${b.notes ? `<dt>Their note</dt><dd>${esc(b.notes)}</dd>` : ''}${prep}
      </dl></details>
      <div class="actions">${actions}</div>
    </article>`;
  }
  const btn = (act, b, label, to) => `<button type="button" class="btn btn-small" data-act="${act}" data-id="${b.id}"${to ? ` data-to="${to}"` : ''}>${label}</button>`;

  $('board').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.getAttribute('aria-busy') === 'true') return;
    const id = Number(t.dataset.id);
    const b = bookings.find((x) => x.id === id);
    if (t.dataset.act === 'deliver-open') return openDeliver(t, b);
    t.setAttribute('aria-busy', 'true');
    try {
      if (t.dataset.act === 'status') {
        const from = b.status;
        await api(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: t.dataset.to } });
        await loadBoard();
        toast(`${b.client_name}: moved to ${t.dataset.to}.`, { actionLabel: 'Undo', onAction: () => undoStatus(id, from) });
      } else if (t.dataset.act === 'cancel') {
        const out = await api(`/api/admin/bookings/${id}/cancel`, { method: 'POST', body: {} });
        await loadBoard();
        toast(`${b.client_name}’s session cancelled. They’ll be emailed in 10 seconds.`, { ms: 9000, actionLabel: 'Undo', onAction: () => undo(id, 'cancel', out.previous) });
      }
    } catch (err) { handle(err); t.removeAttribute('aria-busy'); }
  });

  function openDeliver(button, b) {
    const box = button.closest('.actions');
    box.innerHTML = `<form class="inline-form"><label class="sr-only" for="g${b.id}">Gallery link</label>
      <input id="g${b.id}" type="url" inputmode="url" placeholder="https://… gallery link" required>
      <button class="btn btn-small btn-primary" type="submit">Send</button></form>`;
    const form = box.querySelector('form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const send = form.querySelector('button');
      if (send.getAttribute('aria-busy') === 'true') return;
      send.setAttribute('aria-busy', 'true');
      try {
        const out = await api(`/api/admin/bookings/${b.id}/deliver`, { method: 'POST', body: { galleryUrl: form.querySelector('input').value } });
        await loadBoard();
        toast(`Gallery goes to ${b.client_name} in 10 seconds.`, { ms: 9000, actionLabel: 'Undo', onAction: () => undo(b.id, 'deliver', out.previous) });
      } catch (err) { handle(err); send.removeAttribute('aria-busy'); }
    });
  }

  async function undoStatus(id, to) {
    try { await api(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: to } }); await loadBoard(); toast('Undone.'); } catch (e) { handle(e); }
  }
  async function undo(id, action, previous) {
    try { await api(`/api/admin/bookings/${id}/undo`, { method: 'POST', body: { action, previous } }); await loadBoard(); toast('Undone. No email was sent.'); } catch (e) { handle(e); }
  }

  /* ---------- availability ---------- */
  let packages = [];
  async function loadSettings() {
    let s;
    try { s = await api('/api/admin/settings'); } catch (e) { return handle(e); }
    const a = s.availability;
    for (const period of ['morning', 'evening']) {
      $(period + '-days').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" data-period="${period}" value="${i}"${a[period].includes(i) ? ' checked' : ''}> ${d}</label>`).join('');
    }
    for (const k of ['weeklyCap', 'minNoticeHours', 'maxDaysAhead', 'morningLeadMinutes', 'eveningTailMinutes']) $(k).value = a[k];
    $('blockedDates').value = a.blockedDates.join('\n');
    $('terms').value = s.terms;
    packages = s.packages;
    renderPackages();
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = (period) => [...document.querySelectorAll(`[data-period="${period}"]:checked`)].map((x) => Number(x.value));
    const availability = { morning: days('morning'), evening: days('evening'), blockedDates: $('blockedDates').value.split(/[\s,]+/).filter(Boolean) };
    for (const k of ['weeklyCap', 'minNoticeHours', 'maxDaysAhead', 'morningLeadMinutes', 'eveningTailMinutes']) availability[k] = Number($(k).value);
    try { await api('/api/admin/settings', { method: 'PUT', body: { availability, terms: $('terms').value } }); toast('Saved.'); loadSettings(); } catch (err) { handle(err); }
  });

  /* ---------- packages ---------- */
  const dollars = (c) => (c / 100).toFixed(c % 100 ? 2 : 0);
  function renderPackages() {
    $('package-forms').innerHTML = packages.map(packageForm).join('');
  }
  function packageForm(p) {
    const f = (name, label, value, type = 'text', extra = '') => `<div class="field${extra}"><label for="${name}-${p.id || 'new'}">${label}</label><input id="${name}-${p.id || 'new'}" name="${name}" type="${type}" value="${esc(value)}"${type === 'number' ? ' inputmode="decimal" step="any" min="0"' : ''}></div>`;
    return `<form class="panel pkg-form" data-id="${p.id || ''}">
      <h2>${esc(p.name || 'New package')}</h2>
      <div class="pkg-edit">
        ${f('name', 'Name', p.name || '')}
        ${f('slug', 'Link name <span class="hint">(/book?p=…)</span>', p.slug || '')}
        ${f('summary', 'One-line summary', p.summary || '', 'text', ' wide')}
        ${f('price', 'Price ($)', p.price_cents != null ? dollars(p.price_cents) : '', 'number')}
        ${f('deposit', 'Deposit ($)', p.deposit_cents != null ? dollars(p.deposit_cents) : '', 'number')}
        ${f('minutes', 'Length (minutes)', p.minutes || 60, 'number')}
        ${f('photos', 'Edited photos', p.photos || 25, 'number')}
        ${f('turnaround_days', 'Ready in (days)', p.turnaround_days || 7, 'number')}
        ${f('sort', 'Order', p.sort || 0, 'number')}
        ${f('bg_poster', 'Background still <span class="hint">(/media/… .jpg)</span>', p.bg_poster || '', 'text', ' wide')}
        ${f('bg_video', 'Background clip <span class="hint">(/media/… .mp4, optional)</span>', p.bg_video || '', 'text', ' wide')}
        <label class="check wide"><input type="checkbox" name="active"${p.active === 0 ? '' : ' checked'}> Open for booking</label>
      </div>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>`;
  }
  $('package-forms').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target; const id = form.dataset.id;
    const v = (n) => form.elements[n].value.trim();
    const body = {
      name: v('name'), slug: v('slug'), summary: v('summary'),
      price_cents: Math.round(Number(v('price')) * 100), deposit_cents: Math.round(Number(v('deposit')) * 100),
      minutes: Number(v('minutes')), photos: Number(v('photos')), turnaround_days: Number(v('turnaround_days')), sort: Number(v('sort')),
      bg_poster: v('bg_poster'), bg_video: v('bg_video'), active: form.elements.active.checked,
    };
    try {
      await api(id ? `/api/admin/packages/${id}` : '/api/admin/packages', { method: id ? 'PUT' : 'POST', body });
      toast('Package saved.');
      loadSettings();
    } catch (err) { handle(err); }
  });
  $('add-package').addEventListener('click', () => {
    if (document.querySelector('.pkg-form[data-id=""]')) return;
    $('package-forms').insertAdjacentHTML('beforeend', packageForm({}));
    document.querySelector('.pkg-form[data-id=""] input').focus();
  });

  boot();
})();

/* =====================================================================
   admin.js — the photographer's side.

     Bookings      the pipeline. Each client's Photos window: upload the finished photos, check them, send the gallery.
     Clients       everyone who has booked: their sessions, totals, stage, and a private note.
     Site          the background photos behind every page.
     Availability  when people can book, and the booking terms.
     Packages      prices, lengths, and the photo behind each package's card.

   Moves happen at once with an Undo toast instead of "Are you sure?". Anything that emails the client (send gallery,
   cancel) waits 10 seconds first, so Undo can still take it back. Removing a site photo can't be undone, so that one
   asks first. Uploads go one photo at a time: a failure skips that photo and the rest keep going.
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
  const STAGES = { upcoming: 'Upcoming', editing: 'Editing', delivered: 'Delivered', past: 'Past' };
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
  const loaders = { pipeline: () => loadBoard(), clients: () => loadClients(), site: () => loadSite() };
  document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const name of ['pipeline', 'clients', 'site', 'settings', 'packages']) $('tab-' + name).hidden = name !== t.dataset.tab;
    if (loaders[t.dataset.tab]) loaders[t.dataset.tab]();
  }));
  addEventListener('focus', () => { if (!$('app').hidden && !$('tab-pipeline').hidden && !$('photos').open) loadBoard(); });

  /* ---------- one photo upload (shared by gallery, site and package uploads) ---------- */
  async function uploadOne(url, file) {
    const res = await fetch(url, {
      method: 'PUT', credentials: 'same-origin', body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    }).catch(() => null);
    if (!res) throw Object.assign(new Error('The connection dropped.'), { status: 0 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'That upload failed.'), { status: res.status });
    return data;
  }
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX = 60 * 1024 * 1024;
  function checkFile(f) {
    if (!OK_TYPES.includes(f.type)) return /hei[cf]$/i.test(f.name) ? 'iPhone HEIC: export as JPG first' : 'not a JPG, PNG or WebP';
    if (f.size > MAX) return 'over 60 MB';
    return '';
  }

  /* ======================================================================
     Bookings
     ====================================================================== */
  async function loadBoard() {
    try { bookings = (await api('/api/admin/bookings')).bookings; renderBoard(); } catch (e) { handle(e); }
  }

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
    const photos = btn('photos', b, `Photos${b.photo_count ? ` <span class="num">(${b.photo_count})</span>` : ''}`);
    let actions = '';
    if (b.status === 'booked' || b.status === 'prepped') actions = btn('status', b, 'Mark shot', 'shot') + btn('cancel', b, 'Cancel');
    if (b.status === 'shot') actions = btn('status', b, 'Start editing', 'editing') + photos;
    if (b.status === 'editing') actions = photos;
    if (b.status === 'delivered') actions = photos;
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
    if (t.dataset.act === 'photos') return openPhotos(b);
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

  async function undoStatus(id, to) {
    try { await api(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: to } }); await loadBoard(); toast('Undone.'); } catch (e) { handle(e); }
  }
  async function undo(id, action, previous) {
    try {
      await api(`/api/admin/bookings/${id}/undo`, { method: 'POST', body: { action, previous } });
      await loadBoard(); if (current && current.id === id) refreshCurrent();
      toast('Undone. No email was sent.');
    } catch (e) { handle(e); }
  }

  /* ---------- the Photos window ---------- */
  const dlg = $('photos');
  let current = null; // the booking whose photos are open
  let photos = [];
  let uploading = false;

  function openPhotos(b) {
    current = b; photos = [];
    $('photos-title').textContent = `Photos for ${b.client_name}`;
    $('photos-sub').textContent = `${b.package_name} · ${b.when}`;
    $('photos-status').textContent = '';
    $('photo-grid').innerHTML = '';
    renderFoot();
    dlg.showModal();
    loadPhotos();
  }
  async function loadPhotos() {
    const id = current.id;
    try {
      const out = await api(`/api/admin/bookings/${id}/photos`);
      if (!current || current.id !== id) return;
      photos = out.photos; renderPhotos();
    } catch (e) { handle(e); }
  }
  function refreshCurrent() {
    const fresh = bookings.find((x) => x.id === current.id);
    if (fresh) current = fresh;
    renderFoot();
  }
  function photoTile(p) {
    return `<figure class="thumb" data-photo="${p.id}">
      <img src="/api/admin/photos/${p.id}/thumb" width="${p.width}" height="${p.height}" alt="${esc(p.file_name)}" loading="lazy" decoding="async">
      <button type="button" class="thumb-x" data-remove="${p.id}" aria-label="Remove ${esc(p.file_name)}">×</button>
    </figure>`;
  }
  function renderPhotos() {
    $('photo-grid').innerHTML = photos.map(photoTile).join('');
    renderFoot();
  }
  function renderFoot() {
    const b = current; const n = photos.length;
    const foot = $('photos-foot');
    if (b.status === 'delivered') {
      const own = b.gallery_url && b.gallery_url.includes('/gallery/');
      foot.innerHTML = `<p class="muted">Sent ${b.delivered_at ? new Date(b.delivered_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}.
        ${own ? `Photos you add now appear in their gallery too. <a href="/gallery/${esc(b.token)}" target="_blank" rel="noopener">Open their gallery</a>` : `<a href="${esc(b.gallery_url || '#')}" target="_blank" rel="noopener">Their gallery link</a>`}</p>`;
      return;
    }
    foot.innerHTML = `<details class="alt-link"><summary>Or send a gallery link instead</summary>
        <form class="inline-form" id="link-form"><label class="sr-only" for="gallery-link">Gallery link</label>
        <input id="gallery-link" type="url" inputmode="url" placeholder="https://… gallery link" required>
        <button class="btn btn-small" type="submit">Send link</button></form></details>
      <button type="button" class="btn btn-primary" id="send-gallery"${n && !uploading ? '' : ' disabled'}>${n ? `Send ${n} photo${n === 1 ? '' : 's'} to ${esc(b.client_name.split(' ')[0])}` : 'Add photos to send'}</button>`;
    $('send-gallery').addEventListener('click', () => deliver(''));
    $('link-form').addEventListener('submit', (e) => { e.preventDefault(); deliver($('gallery-link').value); });
  }
  async function deliver(link) {
    const b = current;
    const button = $('send-gallery');
    if (button) button.setAttribute('aria-busy', 'true');
    try {
      const out = await api(`/api/admin/bookings/${b.id}/deliver`, { method: 'POST', body: { galleryUrl: link } });
      await loadBoard(); refreshCurrent();
      toast(`Gallery goes to ${b.client_name} in 10 seconds.`, { ms: 9000, actionLabel: 'Undo', onAction: () => undo(b.id, 'deliver', out.previous) });
    } catch (err) { handle(err); if (button) button.removeAttribute('aria-busy'); }
  }

  async function uploadPhotos(files) {
    if (!current || uploading) return;
    const id = current.id;
    const list = [...files];
    const skipped = list.filter((f) => checkFile(f)).map((f) => `${f.name} (${checkFile(f)})`);
    const good = list.filter((f) => !checkFile(f));
    uploading = true; renderFoot();
    const failed = [];
    for (let i = 0; i < good.length; i++) {
      if (!current || current.id !== id) break; // the window moved to another client
      $('photos-status').textContent = `Uploading ${i + 1} of ${good.length}…`;
      try {
        const out = await uploadOne(`/api/admin/bookings/${id}/photos`, good[i]);
        photos.push(out.photo);
        $('photo-grid').insertAdjacentHTML('beforeend', photoTile(out.photo));
      } catch (e) {
        if (e.status === 401) { uploading = false; dlg.close(); return handle(e); }
        failed.push(`${good[i].name} (${e.message})`);
      }
    }
    uploading = false;
    const done = good.length - failed.length;
    const problems = skipped.concat(failed);
    $('photos-status').textContent = `${done} uploaded.` + (problems.length ? ` Not uploaded: ${problems.join(', ')}.` : '');
    renderFoot();
    loadBoard();
  }
  $('photo-input').addEventListener('change', (e) => { uploadPhotos(e.target.files); e.target.value = ''; });
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); uploadPhotos(e.dataTransfer.files); });

  $('photo-grid').addEventListener('click', async (e) => {
    const x = e.target.closest('[data-remove]');
    if (!x) return;
    const id = Number(x.dataset.remove);
    const p = photos.find((q) => q.id === id);
    try {
      await api(`/api/admin/photos/${id}`, { method: 'DELETE' });
      photos = photos.filter((q) => q.id !== id);
      renderPhotos(); loadBoard();
      toast(`Removed ${p.file_name}.`, { actionLabel: 'Undo', onAction: async () => {
        try { await api(`/api/admin/photos/${id}/restore`, { method: 'POST', body: {} }); if (current) loadPhotos(); loadBoard(); } catch (err) { handle(err); }
      } });
    } catch (err) { handle(err); }
  });
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { if (!uploading) current = null; });
  dlg.addEventListener('cancel', (e) => { if (uploading) { e.preventDefault(); toast('Still uploading. Close when it’s done.'); } });

  /* ======================================================================
     Clients
     ====================================================================== */
  let clients = []; let stageFilter = ''; let open = new Set();
  async function loadClients() {
    try { clients = (await api('/api/admin/clients')).clients; renderClients(); } catch (e) { handle(e); }
  }
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  function renderClients() {
    const q = $('client-search').value.trim().toLowerCase();
    const shown = clients.filter((c) => {
      if (stageFilter === 'repeat' ? !c.repeat : stageFilter && c.stage !== stageFilter) return false;
      if (!q) return true;
      return [c.name, c.email, c.phone, c.packages.join(' ')].join(' ').toLowerCase().includes(q);
    });
    if (!clients.length) { $('client-list').innerHTML = '<p class="empty">No clients yet. They appear here once someone books.</p>'; return; }
    $('client-list').innerHTML = `<p class="muted num">${shown.length} of ${clients.length} clients</p>` + (shown.map((c) => `
      <details class="client panel" data-email="${esc(c.email)}"${open.has(c.email) ? ' open' : ''}>
        <summary>
          <span class="client-main"><b>${esc(c.name)}</b> <span class="badge ${c.stage}">${STAGES[c.stage]}</span>${c.repeat ? ' <span class="badge repeat">Repeat</span>' : ''}
            <small>${esc(c.packages.join(' · '))}</small></span>
          <span class="client-nums num"><span>${c.sessions} session${c.sessions === 1 ? '' : 's'}</span><span>${money(c.totalCents)}</span>
            <small>${c.nextAt ? 'Next ' + date(c.nextAt) : 'Last ' + date(c.lastAt)}</small></span>
        </summary>
        <div class="client-body">
          <p><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>${c.phone ? ` · <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}<br><span class="muted">Client since ${date(c.firstAt)}</span></p>
          <ul class="sessions">${c.bookings.map((b) => `<li><span>${esc(b.package)} · ${esc(b.when)}</span><span class="num">${money(b.priceCents)} · ${esc(b.status)}</span></li>`).join('')}</ul>
          <form class="notes-form"><label for="n-${esc(c.email)}">Private notes <span class="hint">(only you see these)</span></label>
            <textarea id="n-${esc(c.email)}" name="notes" placeholder="Likes moody edits, referred by…, has a second car…">${esc(c.notes)}</textarea>
            <button class="btn btn-small" type="submit">Save notes</button></form>
        </div>
      </details>`).join('') || '<p class="empty">No clients match.</p>');
  }
  $('client-search').addEventListener('input', renderClients);
  $('client-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stage]'); if (!b) return;
    stageFilter = b.dataset.stage;
    $('client-filters').querySelectorAll('[data-stage]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderClients();
  });
  $('client-list').addEventListener('toggle', (e) => {
    const d = e.target.closest('details.client'); if (!d) return;
    if (d.open) open.add(d.dataset.email); else open.delete(d.dataset.email);
  }, true);
  $('client-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = e.target.closest('details.client');
    const notes = e.target.elements.notes.value;
    try {
      await api('/api/admin/clients/notes', { method: 'PUT', body: { email: d.dataset.email, notes } });
      const c = clients.find((x) => x.email === d.dataset.email); if (c) c.notes = notes;
      toast('Notes saved.');
    } catch (err) { handle(err); }
  });

  /* ======================================================================
     Site (background photos)
     ====================================================================== */
  let bgPhotos = [];
  async function loadSite() {
    try { const s = await api('/api/admin/site'); bgPhotos = s.background; $('bg-max').textContent = s.max; renderSite(); } catch (e) { handle(e); }
  }
  function renderSite() {
    $('bg-photos').innerHTML = bgPhotos.map((p, i) => `<figure class="thumb wide" data-key="${esc(p.key)}">
        <img src="${esc(p.thumb)}" width="${p.width}" height="${p.height}" alt="Background photo ${i + 1}" loading="lazy">
        <figcaption>${i === 0 ? '<span class="badge upcoming">Shows first</span>' : `<button type="button" class="btn btn-small" data-first="${esc(p.key)}">Show first</button>`}
          <button type="button" class="btn btn-small btn-text" data-bg-remove="${esc(p.key)}">Remove</button></figcaption>
      </figure>`).join('') || '<p class="empty">No background photos yet: the site uses a plain warm gradient.</p>';
  }
  $('bg-photos').addEventListener('click', async (e) => {
    const first = e.target.closest('[data-first]'); const rm = e.target.closest('[data-bg-remove]');
    try {
      if (first) { bgPhotos = (await api(`/api/admin/site/background/${first.dataset.first}/first`, { method: 'POST', body: {} })).background; renderSite(); toast('That photo now shows first.'); }
      if (rm) {
        if (!confirm('Remove this background photo? You’d have to upload it again to bring it back.')) return;
        bgPhotos = (await api(`/api/admin/site/background/${rm.dataset.bgRemove}`, { method: 'DELETE' })).background; renderSite(); toast('Removed.');
      }
    } catch (err) { handle(err); }
  });
  $('bg-input').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const problems = [];
    for (let i = 0; i < files.length; i++) {
      const bad = checkFile(files[i]);
      if (bad) { problems.push(`${files[i].name} (${bad})`); continue; }
      $('bg-status').textContent = `Uploading ${i + 1} of ${files.length}…`;
      try { bgPhotos = (await uploadOne('/api/admin/site/background', files[i])).background; renderSite(); }
      catch (err) { if (err.status === 401) return handle(err); problems.push(`${files[i].name} (${err.message})`); }
    }
    $('bg-status').textContent = problems.length ? `Not uploaded: ${problems.join(', ')}` : 'Done. It’s live on the site.';
  });

  /* ======================================================================
     Availability
     ====================================================================== */
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

  /* ======================================================================
     Packages
     ====================================================================== */
  const dollars = (c) => (c / 100).toFixed(c % 100 ? 2 : 0);
  function renderPackages() {
    $('package-forms').innerHTML = packages.map(packageForm).join('');
  }
  function packageForm(p) {
    const id = p.id || 'new';
    const f = (name, label, value, type = 'text', extra = '') => `<div class="field${extra}"><label for="${name}-${id}">${label}</label><input id="${name}-${id}" name="${name}" type="${type}" value="${esc(value)}"${type === 'number' ? ' inputmode="decimal" step="any" min="0"' : ''}></div>`;
    const image = p.id ? `<div class="pkg-photo wide">
        ${p.image ? `<img src="${esc(p.image.thumb)}" width="${p.image.width}" height="${p.image.height}" alt="${esc(p.name)} card photo" loading="lazy">` : '<div class="pkg-photo-empty muted">No photo: the card is plain glass.</div>'}
        <div class="upload-row">
          <label class="btn btn-small" for="img-${id}">${p.image ? 'Replace photo' : 'Add card photo'}</label>
          <input class="sr-only" id="img-${id}" type="file" accept="image/jpeg,image/png,image/webp" data-pkg-image="${p.id}">
          ${p.image ? `<button type="button" class="btn btn-small btn-text" data-pkg-image-remove="${p.id}">Remove photo</button>` : ''}
          <span class="muted" data-pkg-status="${p.id}" role="status"></span>
        </div>
      </div>` : '<p class="muted wide">Save the package first, then add its card photo.</p>';
    return `<form class="panel pkg-form" data-id="${p.id || ''}">
      <h2>${esc(p.name || 'New package')}</h2>
      <div class="pkg-edit">
        ${image}
        ${f('name', 'Name', p.name || '')}
        ${f('slug', 'Link name <span class="hint">(/book?p=…)</span>', p.slug || '')}
        ${f('summary', 'One-line summary', p.summary || '', 'text', ' wide')}
        ${f('price', 'Price ($)', p.price_cents != null ? dollars(p.price_cents) : '', 'number')}
        ${f('deposit', 'Deposit ($)', p.deposit_cents != null ? dollars(p.deposit_cents) : '', 'number')}
        ${f('minutes', 'Length (minutes)', p.minutes || 60, 'number')}
        ${f('photos', 'Edited photos', p.photos || 25, 'number')}
        ${f('turnaround_days', 'Ready in (days)', p.turnaround_days || 7, 'number')}
        ${f('sort', 'Order', p.sort || 0, 'number')}
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
      active: form.elements.active.checked,
    };
    try {
      await api(id ? `/api/admin/packages/${id}` : '/api/admin/packages', { method: id ? 'PUT' : 'POST', body });
      toast('Package saved.');
      loadSettings();
    } catch (err) { handle(err); }
  });
  $('package-forms').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-pkg-image]'); if (!input || !input.files[0]) return;
    const file = input.files[0]; const id = input.dataset.pkgImage;
    const status = document.querySelector(`[data-pkg-status="${id}"]`);
    const bad = checkFile(file); if (bad) { status.textContent = `Not uploaded: ${bad}.`; return; }
    status.textContent = 'Uploading…';
    try { await uploadOne(`/api/admin/packages/${id}/image`, file); toast('Card photo saved. It’s live on the site.'); loadSettings(); }
    catch (err) { if (err.status === 401) return handle(err); status.textContent = err.message; }
  });
  $('package-forms').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-pkg-image-remove]'); if (!rm) return;
    if (!confirm('Remove this package’s card photo?')) return;
    try { await api(`/api/admin/packages/${rm.dataset.pkgImageRemove}/image`, { method: 'DELETE' }); toast('Removed.'); loadSettings(); } catch (err) { handle(err); }
  });
  $('add-package').addEventListener('click', () => {
    if (document.querySelector('.pkg-form[data-id=""]')) return;
    $('package-forms').insertAdjacentHTML('beforeend', packageForm({}));
    document.querySelector('.pkg-form[data-id=""] input').focus();
  });

  boot();
})();

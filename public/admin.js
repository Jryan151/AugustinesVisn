/* =====================================================================
   admin.js — the photographer's side.

     Bookings      the pipeline. Each client's Photos window: upload the finished photos, check them, send the gallery.
     Offers        a package made for one client, never listed on the site, sent as a link (/offer/<slug>) they book from.
     Clients       everyone who has booked: their sessions, totals, stage, and a private note.
     Setup         the set-once screens, one at a time:
                     Availability  when people can book, and the booking terms
                     Packages      prices, lengths, and the photo behind each package's card
                     Site photos   the background photos behind every page
                     Payments      Zelle, card status, and the email check
     Guide         how the site works, in plain words (static: nothing to load).

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
    ['hold', 'Waiting for Zelle'],
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
    $('demo-toggle').hidden = !me.admin || me.demo; // in the demo, the note at the bottom has Exit demo
    if (me.admin) { loadBoard(); loadSettings(); } else $('password').focus();
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } }); $('password').value = ''; $('login-error').hidden = true; boot(); }
    catch (err) { $('login-error').textContent = err.message; $('login-error').hidden = false; }
  });
  // The Demo switch: sample data in this browser only, until Exit demo. The first time takes a few seconds (photos).
  $('demo-toggle').addEventListener('click', async () => {
    const b = $('demo-toggle'); if (b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('aria-busy', 'true'); b.textContent = 'Opening demo…';
    try { await api('/api/admin/demo', { method: 'POST', body: { on: true } }); try { sessionStorage.clear(); } catch (err) { /* storage off */ } location.reload(); }
    catch (e) { b.removeAttribute('aria-busy'); b.textContent = 'Demo'; handle(e); }
  });
  $('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); boot(); });
  function handle(err) {
    if (err.status === 401) { boot(); return; }
    toast(err.message, { error: true });
  }

  /* ---------- tabs ---------- */
  // Ordered by how often they're used: daily work first, set-once screens grouped under Setup.
  const TABS = ['pipeline', 'offers', 'clients', 'setup', 'guide'];
  const SETUP = ['settings', 'packages', 'site', 'payments'];
  let setupPart = 'settings';
  const loaders = { pipeline: () => loadBoard(), clients: () => loadClients(), setup: () => showSetup(setupPart) };
  // Availability, packages and offers load with the page (loadSettings); the site photos and payments load when opened.
  const setupLoaders = { site: () => loadSite(), payments: () => loadPayments() };
  document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const name of TABS) $('tab-' + name).hidden = name !== t.dataset.tab;
    if (loaders[t.dataset.tab]) loaders[t.dataset.tab]();
  }));
  function showSetup(name) {
    setupPart = name;
    document.querySelectorAll('[data-setup]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.setup === name)));
    for (const part of SETUP) $('setup-' + part).hidden = part !== name;
    if (setupLoaders[name]) setupLoaders[name]();
  }
  $('setup-nav').addEventListener('click', (e) => { const c = e.target.closest('[data-setup]'); if (c) showSetup(c.dataset.setup); });
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
      if ((status === 'needs_refund' || status === 'hold') && !items.length) return '';
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
    if (b.status === 'hold') actions = btn('zelle', b, `${money(b.deposit_cents)} received`) + btn('cancel', b, 'Release time');
    if (b.status === 'needs_refund') actions = '<p class="meta">Paid after the time was taken. Refund the deposit in Stripe, then email them a new date.</p>';
    return `<article class="card${b.status === 'needs_refund' ? ' attention' : ''}" data-id="${b.id}">
      <h4>${esc(b.client_name)}</h4>
      <div class="meta">${esc(b.package_name)} · ${esc(b.when)}</div>
      <div class="meta num">${b.pay_method === 'in_person' ? `Pays ${money(b.price_cents)} in person` : `Deposit ${money(b.deposit_cents)} · balance ${money(b.price_cents - b.deposit_cents)}`}</div>
      ${b.status === 'hold' ? zelleLine(b) : balanceLine(b)}
      <details><summary>Details${b.prep ? ' and shoot plan' : ''}</summary><dl>
        <dt>Email</dt><dd><a href="mailto:${esc(b.client_email)}">${esc(b.client_email)}</a></dd>
        ${b.client_phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.client_phone)}">${esc(b.client_phone)}</a></dd>` : ''}
        ${b.notes ? `<dt>Their note</dt><dd>${esc(b.notes)}</dd>` : ''}${prep}
      </dl></details>
      <div class="actions">${actions}</div>
    </article>`;
  }
  // A Zelle deposit not confirmed yet: the memo to look for, whether they say it's sent, and when the hold runs out.
  function zelleLine(b) {
    const until = new Date(b.hold_expires_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `<div class="balance"><span class="badge${b.zelle_sent_at ? ' upcoming' : ''}">${b.zelle_sent_at ? 'Says it’s sent' : 'Not sent yet'}</span>
      <span class="meta num">Memo ${esc(b.ref_code || '')} · held until ${esc(until)}</span></div>`;
  }
  // The balance unlocks the client's clean photos. Shown once the session is paid for (not for holds or refunds).
  function balanceLine(b) {
    const due = b.price_cents - b.deposit_cents;
    if (due <= 0 || !['booked', 'prepped', 'shot', 'editing', 'delivered'].includes(b.status)) return '';
    if (b.balance_paid_at) return `<div class="balance"><span class="badge delivered">Balance paid${b.balance_paid_by === 'online' ? ' online' : ''}</span></div>`;
    return `<div class="balance"><span class="badge${b.balance_zelle_sent_at ? ' upcoming' : ''}">${b.balance_zelle_sent_at ? `Says Zelle sent · ${esc(b.ref_code || '')}` : b.pay_method === 'in_person' ? 'Not paid yet' : 'Balance due'}</span>${btn('balance', b, 'Mark paid')}</div>`;
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
      } else if (t.dataset.act === 'zelle') {
        await api(`/api/admin/bookings/${id}/zelle-received`, { method: 'POST', body: {} });
        await loadBoard();
        toast(`${b.client_name} is booked. Their confirmation goes out in 10 seconds.`, { ms: 9000, actionLabel: 'Undo', onAction: () => undo(id, 'zelle', 'booked') });
      } else if (t.dataset.act === 'balance') {
        await api(`/api/admin/bookings/${id}/balance-paid`, { method: 'POST', body: {} });
        await loadBoard();
        toast(b.status === 'delivered' ? `${b.client_name}’s photos unlock and they’re emailed in 10 seconds.` : `${b.client_name}’s balance marked paid.`,
          { ms: 9000, actionLabel: 'Undo', onAction: () => undo(id, 'balance', b.status) });
      } else if (t.dataset.act === 'cancel') {
        const out = await api(`/api/admin/bookings/${id}/cancel`, { method: 'POST', body: {} });
        await loadBoard();
        toast(b.status === 'hold' ? `${b.client_name}’s held time is released.` : `${b.client_name}’s session cancelled. They’ll be emailed in 10 seconds.`,
          { ms: 9000, actionLabel: 'Undo', onAction: () => undo(id, 'cancel', out.previous) });
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
      toast(action === 'balance' ? 'Undone. The balance is due again.' : action === 'zelle' ? 'Undone. Back to waiting for their Zelle.' : 'Undone. No email was sent.');
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
    const due = b.price_cents - b.deposit_cents;
    $('photos-sub').textContent = `${b.package_name} · ${b.when}` + (due > 0 && !b.balance_paid_at ? ` · The client sees watermarked previews until the ${money(due)} balance is paid.` : '');
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
  let bgPhotos = []; let adminBg = { mode: 'site', key: null };
  async function loadSite() {
    try { const s = await api('/api/admin/site'); bgPhotos = s.background; adminBg = s.adminBackground; $('bg-max').textContent = s.max; renderSite(); } catch (e) { handle(e); }
  }

  /* ---------- Behind Admin: off, the site's photos, or one of them (the owner's choice, for the look) ---------- */
  function renderAdminBg() {
    const none = !bgPhotos.length;
    // The chosen photo was removed: the server falls back to the site's photos, so show that.
    if (adminBg.mode === 'photo' && adminBg.key && !bgPhotos.some((p) => p.key === adminBg.key)) adminBg = { mode: 'site', key: null };
    $('admin-bg-note').hidden = !none;
    document.querySelectorAll('[data-admin-bg]').forEach((c) => { c.setAttribute('aria-pressed', String(c.dataset.adminBg === adminBg.mode)); c.disabled = none && c.dataset.adminBg !== 'off'; });
    $('admin-bg-photos').hidden = adminBg.mode !== 'photo' || none;
    $('admin-bg-photos').innerHTML = bgPhotos.map((p, i) => `<button type="button" data-admin-bg-key="${esc(p.key)}" aria-pressed="${p.key === adminBg.key}" aria-label="Use background photo ${i + 1} behind Admin">
        <img src="${esc(p.thumb)}" width="${p.width}" height="${p.height}" alt="" loading="lazy"></button>`).join('');
  }
  async function saveAdminBg(mode, key) {
    try {
      const out = await api('/api/admin/site/admin-background', { method: 'PUT', body: { mode, key } });
      adminBg = out.adminBackground; renderAdminBg();
      // Swap the layer behind this page at once (no reload, you stay where you are).
      const old = document.querySelector('body > .bg'); if (old) old.remove();
      if (out.markup) { document.body.insertAdjacentHTML('afterbegin', out.markup); AV.startBackground(document.body.firstElementChild); }
      toast(mode === 'off' ? 'Admin is back to plain.' : 'Saved. That’s what’s behind Admin now.');
    } catch (err) { handle(err); }
  }
  $('admin-bg-modes').addEventListener('click', (e) => {
    const c = e.target.closest('[data-admin-bg]'); if (!c || c.disabled) return;
    const mode = c.dataset.adminBg;
    // One photo: show the choices; the first tap on a photo saves it. (Already on one? Keep it.)
    if (mode === 'photo' && adminBg.mode !== 'photo') { adminBg = { mode: 'photo', key: null }; renderAdminBg(); return; }
    if (mode !== 'photo') saveAdminBg(mode);
  });
  $('admin-bg-photos').addEventListener('click', (e) => { const b = e.target.closest('[data-admin-bg-key]'); if (b) saveAdminBg('photo', b.dataset.adminBgKey); });
  // Admin's own thumbnails show each photo framed as saved (the site gets the same from /site.css).
  function applyFrames(root, list) {
    for (const p of list) root.querySelectorAll(`img.framed[data-key="${p.key}"]`).forEach((img) => setFrame(img, p));
  }
  function renderSite() {
    setTimeout(() => applyFrames($('bg-photos'), bgPhotos));
    $('bg-photos').innerHTML = bgPhotos.map((p, i) => `<figure class="thumb wide" data-key="${esc(p.key)}">
        <div class="crop"><img src="${esc(p.thumb)}" data-key="${esc(p.key)}" class="framed" width="${p.width}" height="${p.height}" alt="Background photo ${i + 1}" loading="lazy"></div>
        <figcaption>${i === 0 ? '<span class="badge upcoming">Shows first</span>' : `<button type="button" class="btn btn-small" data-first="${esc(p.key)}">Show first</button>`}
          <button type="button" class="btn btn-small" data-bg-frame="${esc(p.key)}">Adjust</button>
          <button type="button" class="btn btn-small btn-text" data-bg-remove="${esc(p.key)}">Remove</button></figcaption>
      </figure>`).join('') || '<p class="empty">No background photos yet: the site uses a plain warm gradient.</p>';
    renderAdminBg();
  }
  $('bg-photos').addEventListener('click', async (e) => {
    const first = e.target.closest('[data-first]'); const rm = e.target.closest('[data-bg-remove]');
    const adj = e.target.closest('[data-bg-frame]');
    if (adj) {
      const p = bgPhotos.find((x) => x.key === adj.dataset.bgFrame);
      return openFramer(p, BG_SHAPES, async (frame) => { bgPhotos = (await api(`/api/admin/site/background/${p.key}/frame`, { method: 'PUT', body: frame })).background; renderSite(); });
    }
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
  // Packages (under Setup) and offers (their own tab) use the same form, so the same handlers serve both.
  const forBoth = (ev, fn) => { $('setup-packages').addEventListener(ev, fn); $('tab-offers').addEventListener(ev, fn); };
  // The packages on the site (in their order), and the offers (each reached only by its link).
  const shelf = () => packages.filter((p) => !p.offer);
  function renderPackages() {
    $('package-forms').innerHTML = shelf().map(packageForm).join('');
    $('offer-forms').innerHTML = packages.filter((p) => p.offer).map(packageForm).join('');
    applyFrames($('setup-packages'), packages.filter((p) => p.image).map((p) => p.image));
    loadPortfolios();
  }
  function packageForm(p) {
    const id = p.id || 'new';
    const f = (name, label, value, type = 'text', extra = '') => `<div class="field${extra}"><label for="${name}-${id}">${label}</label><input id="${name}-${id}" name="${name}" type="${type}" value="${esc(value)}"${type === 'number' ? ' inputmode="decimal" step="any" min="0"' : ''}></div>`;
    // Offers never get a card on the site, so they have no card photo.
    const image = p.offer ? '' : p.id ? `<div class="pkg-photo wide">
        ${p.image ? `<div class="crop pkg-crop"><img src="${esc(p.image.thumb)}" data-key="${esc(p.image.key)}" class="framed" width="${p.image.width}" height="${p.image.height}" alt="${esc(p.name)} card photo" loading="lazy"></div>` : '<div class="pkg-photo-empty muted">No photo: the card is plain glass.</div>'}
        <div class="upload-row">
          <label class="btn btn-small" for="img-${id}">${p.image ? 'Replace photo' : 'Add card photo'}</label>
          <input class="sr-only" id="img-${id}" type="file" accept="image/jpeg,image/png,image/webp" data-pkg-image="${p.id}">
          ${p.image ? `<button type="button" class="btn btn-small" data-pkg-frame="${p.id}">Adjust</button>
            <button type="button" class="btn btn-small btn-text" data-pkg-image-remove="${p.id}">Remove photo</button>` : ''}
          <span class="muted" data-pkg-status="${p.id}" role="status"></span>
        </div>
      </div>` : '<p class="muted wide">Save the package first, then add its card photo.</p>';
    const list = shelf();
    const i = list.findIndex((x) => x.id === p.id);
    const move = p.offer ? (p.id ? `<div class="offer-link">
        <button type="button" class="btn btn-small btn-primary" data-send="${esc(p.slug)}" data-name="${esc(p.name)}">Send link</button>
        <a class="btn btn-small btn-text" href="/offer/${esc(p.slug)}" target="_blank" rel="noopener">View</a>
      </div>` : '<span class="muted">Save it to get its link.</span>') : p.id ? `<div class="pkg-move" role="group" aria-label="Order on the site">
        <span class="muted num">${i + 1} of ${list.length}</span>
        <button type="button" class="btn btn-small" data-move="-1" data-id="${p.id}" aria-label="Move ${esc(p.name)} earlier"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn btn-small" data-move="1" data-id="${p.id}" aria-label="Move ${esc(p.name)} later"${i === list.length - 1 ? ' disabled' : ''}>↓</button>
      </div>` : '<span class="muted">Goes last; move it once saved.</span>';
    return `<form class="panel pkg-form" data-id="${p.id || ''}"${p.offer ? ' data-offer="1"' : ''}>
      <div class="pkg-head"><h2>${esc(p.name || (p.offer ? 'New offer' : 'New package'))}</h2>${move}</div>
      <div class="pkg-edit">
        ${image}
        ${f('name', p.offer ? 'Title <span class="hint">(the client sees this)</span>' : 'Title <span class="hint">(shown on the package card)</span>', p.name || '', 'text', ' wide')}
        ${p.offer ? '' : f('slug', 'Link name <span class="hint">(/book?p=…)</span>', p.slug || '')}
        ${f('summary', p.offer ? 'What it’s for <span class="hint">(a line or two, in your words)</span>' : 'One-line summary', p.summary || '', 'text', ' wide')}
        ${f('price', 'Price ($)', p.price_cents != null ? dollars(p.price_cents) : '', 'number')}
        ${f('deposit', 'Deposit ($)', p.deposit_cents != null ? dollars(p.deposit_cents) : '', 'number')}
        ${f('minutes', 'Length (minutes)', p.minutes || 60, 'number')}
        ${f('photos', 'Edited photos', p.photos || 25, 'number')}
        ${f('turnaround_days', 'Ready in (days)', p.turnaround_days || 7, 'number')}
        <label class="check wide"><input type="checkbox" name="active"${p.active === 0 ? '' : ' checked'}> Open for booking</label>
      </div>
      <button class="btn btn-primary" type="submit">Save</button>
      ${p.id ? `<section class="portfolio-admin" aria-labelledby="pf-title-${p.id}">
        <h3 id="pf-title-${p.id}">Portfolio <span class="hint num" data-pf-count="${p.id}">${p.portfolio_count || 0} photos</span></h3>
        <p class="muted">${p.offer ? 'Example shots, shown on the offer’s page.' : `Example shots for this package. Visitors reach them from “See portfolio” on the package’s photo.${p.image ? '' : ' (Add a card photo too: the button sits on it.)'}`}</p>
        <div class="thumbs" data-pf-grid="${p.id}"></div>
        <div class="upload-row">
          <label class="btn btn-small" for="pf-${p.id}">Add portfolio photos</label>
          <input class="sr-only" id="pf-${p.id}" type="file" accept="image/jpeg,image/png,image/webp" multiple data-pf-input="${p.id}">
          ${p.portfolio_count && !p.offer ? `<a class="btn btn-small btn-text" href="/portfolio/${esc(p.slug)}" target="_blank" rel="noopener">View page</a>` : ''}
          <span class="muted" data-pf-status="${p.id}" role="status"></span>
        </div>
      </section>` : ''}
    </form>`;
  }

  /* ---------- a package's portfolio ---------- */
  function renderPortfolio(id, photos) {
    const grid = document.querySelector(`[data-pf-grid="${id}"]`); if (!grid) return;
    grid.innerHTML = photos.map((ph, i) => `<figure class="thumb">
        <img src="${esc(ph.thumb)}" width="${ph.width}" height="${ph.height}" alt="Portfolio photo ${i + 1}" loading="lazy">
        ${i ? `<button type="button" class="thumb-first" data-pf-first="${ph.id}" data-pkg="${id}" aria-label="Show photo ${i + 1} first">First</button>` : ''}
        <button type="button" class="thumb-x" data-pf-remove="${ph.id}" data-pkg="${id}" aria-label="Remove portfolio photo ${i + 1}">×</button>
      </figure>`).join('');
    const count = document.querySelector(`[data-pf-count="${id}"]`);
    if (count) count.textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
    const p = packages.find((x) => x.id === Number(id)); if (p) p.portfolio_count = photos.length;
  }
  function loadPortfolios() {
    for (const p of packages) if (p.id && p.portfolio_count) api(`/api/admin/packages/${p.id}/portfolio`).then((r) => renderPortfolio(p.id, r.photos)).catch(handle);
  }
  forBoth('submit', async (e) => {
    e.preventDefault();
    const form = e.target; const id = form.dataset.id;
    const v = (n) => form.elements[n].value.trim();
    const body = {
      name: v('name'), slug: form.elements.slug ? v('slug') : '', summary: v('summary'), offer: form.dataset.offer === '1',
      price_cents: Math.round(Number(v('price')) * 100), deposit_cents: Math.round(Number(v('deposit')) * 100),
      minutes: Number(v('minutes')), photos: Number(v('photos')), turnaround_days: Number(v('turnaround_days')),
      active: form.elements.active.checked,
    };
    try {
      await api(id ? `/api/admin/packages/${id}` : '/api/admin/packages', { method: id ? 'PUT' : 'POST', body });
      toast(form.dataset.offer ? (id ? 'Offer saved. Its link stays the same.' : 'Offer saved. Tap Send link to share it.') : 'Package saved.');
      loadSettings();
    } catch (err) { handle(err); }
  });
  // The form's heading follows the title as it's typed, so it's clear which field renames the package.
  forBoth('input', (e) => {
    if (e.target.name !== 'name') return;
    e.target.form.querySelector('h2').textContent = e.target.value.trim() || (e.target.form.dataset.offer ? 'New offer' : 'New package');
  });
  forBoth('change', async (e) => {
    const pf = e.target.closest('[data-pf-input]');
    if (pf) {
      const id = pf.dataset.pfInput; const files = [...pf.files]; pf.value = '';
      const status = document.querySelector(`[data-pf-status="${id}"]`);
      const problems = [];
      for (let i = 0; i < files.length; i++) {
        const bad = checkFile(files[i]);
        if (bad) { problems.push(`${files[i].name} (${bad})`); continue; }
        status.textContent = `Uploading ${i + 1} of ${files.length}…`;
        try { renderPortfolio(id, (await uploadOne(`/api/admin/packages/${id}/portfolio`, files[i])).photos); }
        catch (err) { if (err.status === 401) return handle(err); problems.push(`${files[i].name} (${err.message})`); }
      }
      status.textContent = problems.length ? `Not uploaded: ${problems.join(', ')}` : 'Done. It’s live on the site.';
      return;
    }
    const input = e.target.closest('[data-pkg-image]'); if (!input || !input.files[0]) return;
    const file = input.files[0]; const id = input.dataset.pkgImage;
    const status = document.querySelector(`[data-pkg-status="${id}"]`);
    const bad = checkFile(file); if (bad) { status.textContent = `Not uploaded: ${bad}.`; return; }
    status.textContent = 'Uploading…';
    try { await uploadOne(`/api/admin/packages/${id}/image`, file); toast('Card photo saved. It’s live on the site.'); loadSettings(); }
    catch (err) { if (err.status === 401) return handle(err); status.textContent = err.message; }
  });
  forBoth('click', async (e) => {
    const pfRm = e.target.closest('[data-pf-remove]'); const pfFirst = e.target.closest('[data-pf-first]');
    if (pfRm || pfFirst) {
      e.preventDefault();
      try {
        if (pfFirst) renderPortfolio(pfFirst.dataset.pkg, (await api(`/api/admin/portfolio/${pfFirst.dataset.pfFirst}/first`, { method: 'POST', body: {} })).photos);
        else {
          if (!confirm('Remove this portfolio photo? You’d have to upload it again to bring it back.')) return;
          renderPortfolio(pfRm.dataset.pkg, (await api(`/api/admin/portfolio/${pfRm.dataset.pfRemove}`, { method: 'DELETE' })).photos);
        }
      } catch (err) { handle(err); }
      return;
    }
    const send = e.target.closest('[data-send]');
    if (send) {
      const url = `${location.origin}/offer/${send.dataset.send}`;
      // On a phone this opens the share sheet (Messages, Instagram…); elsewhere the link is copied.
      if (navigator.share) { try { await navigator.share({ title: send.dataset.name, url }); } catch (err) { /* closed the sheet */ } return; }
      try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it in your message.'); } catch (err) { prompt('Copy this link:', url); }
      return;
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const before = shelf().map((p) => p.id);
      const ids = before.slice();
      const i = ids.indexOf(Number(mv.dataset.id)); const j = i + Number(mv.dataset.move);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        await saveOrder(ids);
        const name = packages.find((p) => p.id === Number(mv.dataset.id)).name;
        toast(`${name} is now ${ordinal(j + 1)} on the site.`, { actionLabel: 'Undo', onAction: () => saveOrder(before).catch(handle) });
        // Keep the moved package's button under the finger/keyboard.
        const again = document.querySelector(`[data-move="${mv.dataset.move}"][data-id="${mv.dataset.id}"]`);
        if (again && !again.disabled) again.focus();
      } catch (err) { handle(err); }
      return;
    }
    const adj = e.target.closest('[data-pkg-frame]');
    if (adj) {
      const p = packages.find((x) => String(x.id) === adj.dataset.pkgFrame);
      return openFramer(p.image, CARD_SHAPES, async (frame) => { await api(`/api/admin/packages/${p.id}/image/frame`, { method: 'PUT', body: frame }); loadSettings(); });
    }
    const rm = e.target.closest('[data-pkg-image-remove]'); if (!rm) return;
    if (!confirm('Remove this package’s card photo?')) return;
    try { await api(`/api/admin/packages/${rm.dataset.pkgImageRemove}/image`, { method: 'DELETE' }); toast('Removed.'); loadSettings(); } catch (err) { handle(err); }
  });
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  async function saveOrder(ids) {
    packages = (await api('/api/admin/packages/order', { method: 'PUT', body: { ids } })).packages;
    renderPackages();
  }
  $('add-package').addEventListener('click', () => {
    if ($('package-forms').querySelector('.pkg-form[data-id=""]')) return;
    $('package-forms').insertAdjacentHTML('beforeend', packageForm({}));
    $('package-forms').querySelector('.pkg-form[data-id=""] input').focus();
  });
  $('add-offer').addEventListener('click', () => {
    if ($('offer-forms').querySelector('.pkg-form[data-id=""]')) return;
    $('offer-forms').insertAdjacentHTML('beforeend', packageForm({ offer: 1 }));
    $('offer-forms').querySelector('.pkg-form[data-id=""] input').focus();
  });

  /* ======================================================================
     Adjust a photo: drag to move what stays in view, slide to zoom
     ====================================================================== */
  // The shapes each photo is really cropped to on the site.
  const CARD_SHAPES = [{ label: 'Package card', w: 300, h: 330 }];
  const BG_SHAPES = [{ label: 'Phone', w: 150, h: 325 }, { label: 'Computer', w: 400, h: 225 }];
  const fr = $('framer');
  let framing = null; // { photo, frame: { fx, fy, zoom }, save }

  function setFrame(img, f) {
    img.style.objectPosition = `${f.fx}% ${f.fy}%`;
    img.style.setProperty('--fx', f.fx + '%'); img.style.setProperty('--fy', f.fy + '%'); img.style.setProperty('--zoom', f.zoom);
  }
  function paintFrames() {
    fr.querySelectorAll('.framer-img').forEach((img) => setFrame(img, framing.frame));
    $('framer-zoom').value = Math.round(framing.frame.zoom * 100);
    $('framer-zoom-value').textContent = Math.round(framing.frame.zoom * 100) + '%';
  }
  function openFramer(photo, shapes, save) {
    framing = { photo, frame: { fx: photo.fx ?? 50, fy: photo.fy ?? 50, zoom: photo.zoom ?? 1 }, save };
    $('framer-frames').innerHTML = shapes.map((s) => `<figure class="framer-shape">
        <div class="framer-frame" tabindex="0" role="group" aria-label="${s.label} preview: drag or use arrow keys to move the photo" data-w="${s.w}" data-h="${s.h}">
          <img class="framer-img" src="${esc(photo.web)}" alt="" draggable="false">
        </div><figcaption class="muted">${s.label}</figcaption></figure>`).join('');
    fr.querySelectorAll('.framer-frame').forEach((el) => { el.style.width = el.dataset.w + 'px'; el.style.aspectRatio = `${el.dataset.w} / ${el.dataset.h}`; });
    paintFrames();
    fr.showModal();
  }
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n * 10) / 10));
  let drag = null;
  $('framer-frames').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.framer-frame'); if (!el) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    drag = { el, x: e.clientX, y: e.clientY, fx: framing.frame.fx, fy: framing.frame.fy };
  });
  $('framer-frames').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = drag.el.getBoundingClientRect();
    // Dragging the photo right shows more of its left side, so the focus moves the other way.
    framing.frame.fx = clamp(drag.fx - ((e.clientX - drag.x) / r.width) * 100 / framing.frame.zoom);
    framing.frame.fy = clamp(drag.fy - ((e.clientY - drag.y) / r.height) * 100 / framing.frame.zoom);
    paintFrames();
  });
  const endDrag = () => { drag = null; };
  $('framer-frames').addEventListener('pointerup', endDrag);
  $('framer-frames').addEventListener('pointercancel', endDrag);
  $('framer-frames').addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    framing.frame.fx = clamp(framing.frame.fx + moves[e.key][0]);
    framing.frame.fy = clamp(framing.frame.fy + moves[e.key][1]);
    paintFrames();
  });
  $('framer-zoom').addEventListener('input', (e) => { framing.frame.zoom = Number(e.target.value) / 100; paintFrames(); });
  $('framer-reset').addEventListener('click', () => { framing.frame = { fx: 50, fy: 50, zoom: 1 }; paintFrames(); });
  $('framer-save').addEventListener('click', async () => {
    const b = $('framer-save');
    if (b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('aria-busy', 'true');
    try { await framing.save(framing.frame); fr.close(); toast('Saved. It’s live on the site.'); } catch (err) { handle(err); }
    b.removeAttribute('aria-busy');
  });
  fr.querySelector('[data-close]').addEventListener('click', () => fr.close());

  /* ======================================================================
     Payments & email
     ====================================================================== */
  async function loadPayments() {
    try {
      const [p, m] = await Promise.all([api('/api/admin/payments'), api('/api/admin/email')]);
      renderPayments(p); renderEmail(m);
    } catch (e) { handle(e); }
  }
  function renderPayments(p) {
    const z = p.zelle;
    $('ip-enabled').checked = p.methods.inPerson;
    $('z-enabled').checked = z.enabled; $('z-recipient').value = z.recipient; $('z-name').value = z.name; $('z-hold').value = z.holdHours;
    $('z-qr').innerHTML = z.qr ? `<img src="${esc(z.qr.url)}" alt="Your Zelle QR code"><button type="button" class="btn btn-small btn-text" id="z-qr-remove">Remove QR code</button>` : '<p class="muted">No QR code: clients copy your Zelle details instead.</p>';
    const rm = $('z-qr-remove'); if (rm) rm.addEventListener('click', async () => { try { renderPayments(Object.assign(p, await api('/api/admin/payments/zelle-qr', { method: 'DELETE' }))); } catch (e) { handle(e); } });
    $('card-status').innerHTML = p.stripe
      ? '<span class="badge delivered">Card payments on</span> Clients can pay by card through Stripe.'
      : '<span class="badge">Card payments off</span> No Stripe key yet, so clients pay by Zelle (or in person).';
    const ways = [p.methods.inPerson && 'in person', p.methods.zelle && 'Zelle', p.methods.card && 'card'].filter(Boolean);
    $('pay-summary').textContent = ways.length
      ? `Clients can book and pay ${ways.join(', ').replace(/, ([^,]*)$/, ' or $1')}.`
      : 'Booking is closed: turn on in person or Zelle (or add Stripe) so clients can book.';
  }
  $('zelle-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { inPerson: { enabled: $('ip-enabled').checked }, zelle: { enabled: $('z-enabled').checked, recipient: $('z-recipient').value, name: $('z-name').value, holdHours: Number($('z-hold').value) } };
    try { renderPayments(await api('/api/admin/payments', { method: 'PUT', body })); toast('Saved.'); } catch (err) { handle(err); }
  });
  $('z-qr-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    const bad = checkFile(file); if (bad) return toast(`Not uploaded: ${bad}.`, { error: true });
    try { await uploadOne('/api/admin/payments/zelle-qr', file); loadPayments(); toast('QR code saved.'); } catch (err) { handle(err); }
  });
  function renderEmail(m) {
    const rows = [
      ['Sending through Resend', m.resend ? 'Yes' : 'Not yet: emails only show in the server log'],
      ['Sent from', m.from ? m.from + (m.fromIsTestAddress && m.resend ? ' (Resend’s test address: only reaches you)' : '') : '—'],
      ['Your notices go to', m.adminEmail || 'Not set (ADMIN_EMAIL)'],
      ['Sent in the last day', String(m.sentToday)],
      ['Waiting to send', String(m.waiting)],
    ];
    $('email-status').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('email-failed').innerHTML = m.failed.length
      ? '<h3>Problems</h3>' + m.failed.map((f) => `<p class="error-box">${esc(f.subject)} → ${esc(f.to_addr)}: ${esc(f.last_error || 'retrying')}</p>`).join('')
      : '';
  }
  $('email-test').addEventListener('click', async (e) => {
    const b = e.currentTarget; if (b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('aria-busy', 'true');
    try { const r = await api('/api/admin/email/test', { method: 'POST', body: {} }); toast(r.viaResend ? `Sent to ${r.to}. Check your inbox (and spam).` : 'Logged on the server: add RESEND_API_KEY to really send.'); loadPayments(); }
    catch (err) { handle(err); }
    b.removeAttribute('aria-busy');
  });

  boot();
})();

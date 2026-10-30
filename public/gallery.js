/* =====================================================================
   gallery.js — a client's finished photos (/gallery/<token>).

   Before the balance is paid, the photos shown are watermarked previews and there's nothing to download; a button
   pays the balance (Stripe). Paid, the clean photos appear with Download and Download all. Coming back from paying,
   the page checks every 2 seconds until the payment is confirmed (Stripe tells the server a moment later).
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money, toast } = AV;
  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  const base = '/g/' + encodeURIComponent(token);
  const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';
  const justPaid = new URLSearchParams(location.search).get('paid') === '1';
  let key = null; let tries = 0;

  function render(g) {
    $('title').textContent = `${g.name.split(' ')[0]}’s photos`;
    const total = g.photos.reduce((s, p) => s + p.bytes, 0);
    $('sub').innerHTML = `${esc(g.package)} · ${esc(g.when)}<br><span class="num">${g.photos.length} photos${g.locked ? '' : ' · ' + mb(total)}</span>`;
    $('all').hidden = g.locked;
    $('all').href = base + '/all.zip';

    $('unlock').hidden = !g.locked;
    if (g.locked) {
      const waiting = justPaid && tries < 15;
      $('unlock-text').textContent = waiting
        ? 'Confirming your payment…'
        : `Pay the ${money(g.balanceCents)} balance to download every photo in full quality, without the watermark.`;
      $('pay').hidden = waiting || !g.canPayOnline;
      $('pay').textContent = `Pay ${money(g.balanceCents)} by card`;
      // Zelle: no fees. Shown with the card button, or on its own when card isn't set up.
      $('zelle').hidden = waiting || !g.zelle;
      if (g.zelle && !waiting) {
        $('zelle').innerHTML = `<h3 class="unlock-or">${g.canPayOnline ? 'Or pay by Zelle (no fees)' : 'Pay by Zelle (no fees)'}</h3>` +
          AV.zellePanel({ zelle: g.zelle, amountCents: g.balanceCents, ref: g.ref, sent: g.zelleSent, what: 'balance' });
        const sent = $('zelle').querySelector('[data-zelle-sent]');
        if (sent) sent.addEventListener('click', async () => {
          if (sent.getAttribute('aria-busy') === 'true') return;
          sent.setAttribute('aria-busy', 'true');
          try { await api(`/api/gallery/${encodeURIComponent(token)}/zelle-sent`, { method: 'POST', body: {} }); load(); }
          catch (e) { sent.removeAttribute('aria-busy'); toast(e.message, { error: true }); }
        });
      }
      if (!g.canPayOnline && !g.zelle) $('unlock-text').textContent = `Pay the ${money(g.balanceCents)} balance in person and your photos unlock here, in full quality.`;
      if (waiting) { tries++; setTimeout(load, 2000); }
    } else if (justPaid) {
      toast('Paid. Your photos are unlocked.');
      history.replaceState(null, '', location.pathname);
    }

    // Proofs and clean photos have different addresses, so paying never shows a saved watermarked copy.
    const v = g.locked ? '?proof' : '?full';
    $('grid').innerHTML = g.photos.map((p, i) => `<figure>
      <a class="view" href="${base}/${p.id}/web${v}" target="_blank" rel="noopener">
        <img src="${base}/${p.id}/thumb${v}" width="${p.width}" height="${p.height}" alt="Photo ${i + 1} of ${g.photos.length}${g.locked ? ' (preview)' : ''}" loading="${i < 6 ? 'eager' : 'lazy'}" decoding="async">
      </a>
      ${g.locked ? '' : `<a class="dl" href="${base}/${p.id}/original" download="${esc(p.file_name)}" aria-label="Download photo ${i + 1}">Download</a>`}
    </figure>`).join('');
    // A preview that isn't ready (still being made) shows a calm placeholder, never a broken image.
    $('grid').querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.closest('figure').classList.add('not-ready'), { once: true }));
  }

  function load() {
    api('/api/gallery/' + encodeURIComponent(token)).then(render).catch((e) => {
      const box = $('error');
      box.textContent = e.status === 404 ? 'This gallery isn’t ready yet, or the link is wrong. Check the link in your email.' : e.message;
      box.hidden = false;
    });
  }

  $('pay').addEventListener('click', async () => {
    const b = $('pay');
    if (b.getAttribute('aria-busy') === 'true') return;
    b.setAttribute('aria-busy', 'true');
    if (!key) key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    try {
      const out = await api(`/api/gallery/${encodeURIComponent(token)}/pay`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: {} });
      if (out.paid) return load();
      location.assign(out.checkoutUrl);
    } catch (e) {
      b.removeAttribute('aria-busy');
      if (e.status >= 400 && e.status < 500) key = null;
      toast(e.message, { error: true });
    }
  });

  load();
})();

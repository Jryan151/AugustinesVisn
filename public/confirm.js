/* =====================================================================
   confirm.js — the photographer's one-tap Confirm for a Zelle payment (/confirm/<signed code>, from the email).

   Shows who, what and how much, and the memo to look for. "It's in my account" confirms it: the booking is confirmed
   (deposit) or the photos unlock (balance). The client's email waits 10 seconds, so Undo still works here.
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money, toast } = AV;
  const box = document.getElementById('box');
  const code = location.pathname.split('/').filter(Boolean)[1] || '';
  const url = '/api/confirm/' + encodeURIComponent(code);
  const LABEL = { deposit: 'deposit', balance: 'balance' };

  function facts(d) {
    return `<dl class="summary">
      <div><dt>From</dt><dd>${esc(d.client)}</dd></div>
      <div><dt>For</dt><dd>${esc(d.package)} · ${esc(d.when)}</dd></div>
      <div><dt>Amount</dt><dd class="price">${money(d.amountCents)} ${LABEL[d.what]}</dd></div>
      <div><dt>Memo to look for</dt><dd class="num"><b>${esc(d.ref)}</b></dd></div>
    </dl>`;
  }

  function render(d, justDone) {
    if (d.unavailable) {
      box.innerHTML = `<h1 class="display">Nothing to confirm</h1>${facts(d)}<p class="muted">This booking was cancelled. If money arrived, send it back through Zelle.</p>`;
      return;
    }
    if (d.done) {
      const msg = d.needsRefund
        ? '<p class="error-box">Their hold had run out and the time went to someone else, so this is marked for a refund. Send it back through Zelle and offer another date.</p>'
        : `<p>${d.what === 'deposit' ? 'Booked. They’ll get their confirmation in a few seconds.' : 'Their photos are unlocked. They’ll get an email in a few seconds.'}</p>`;
      box.innerHTML = `<h1 class="display">Confirmed</h1>${facts(d)}${justDone ? msg : '<p class="muted">This was already confirmed.</p>'}
        ${justDone && !d.needsRefund ? '<button type="button" class="btn" id="undo">Undo</button>' : ''}
        <p><a class="btn btn-text" href="/admin">Open Admin</a></p>`;
      const u = document.getElementById('undo');
      if (u) {
        const t = setTimeout(() => u.remove(), 9000);
        u.addEventListener('click', async () => {
          clearTimeout(t);
          try { render(await api(url + '/undo', { method: 'POST', body: {} })); toast('Undone. Nothing was sent to them.'); }
          catch (e) { toast(e.message, { error: true }); u.remove(); }
        });
      }
      return;
    }
    box.innerHTML = `<h1 class="display">Did it arrive?</h1>
      <p>${esc(d.client)} ${d.sentAt ? 'says they sent' : 'is paying'} the ${LABEL[d.what]} by Zelle. Check your bank app for the amount and memo below.</p>
      ${facts(d)}
      <button type="button" class="btn btn-primary btn-large" id="yes">It’s in my account</button>
      <p class="muted fine">Not there yet? Leave this and come back to the link later. It works for 14 days.</p>`;
    document.getElementById('yes').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (b.getAttribute('aria-busy') === 'true') return;
      b.setAttribute('aria-busy', 'true');
      try { render(await api(url, { method: 'POST', body: {} }), true); }
      catch (err) { b.removeAttribute('aria-busy'); toast(err.message, { error: true }); }
    });
  }

  api(url).then((d) => render(d)).catch((e) => {
    box.innerHTML = `<h1 class="display">That link didn’t work</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/admin">Open Admin</a>`;
  });
})();

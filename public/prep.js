/* prep.js — the client's prep questionnaire (/prep/<token>). Answers can be changed up to the shoot. */
(function () {
  'use strict';
  const { api, toast } = AV;
  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  const form = document.getElementById('prep');
  const err = document.getElementById('error');
  const FIELDS = ['location', 'look', 'who', 'references', 'other'];

  api('/api/bookings/' + encodeURIComponent(token)).then((b) => {
    if (!['booked', 'prepped'].includes(b.status)) {
      err.textContent = b.status === 'hold' ? 'Your deposit isn’t confirmed yet. Try this link again in a minute.' : 'This booking isn’t taking shoot details any more.';
      err.hidden = false; return;
    }
    document.getElementById('when').textContent = `${b.package.name} · ${b.when}`;
    for (const k of FIELDS) if (b.prep && b.prep[k]) form[k].value = b.prep[k];
    form.hidden = false;
  }).catch((e) => { err.textContent = e.message; err.hidden = false; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save');
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true'); err.hidden = true;
    const body = {}; for (const k of FIELDS) body[k] = form[k].value;
    try {
      await api(`/api/bookings/${encodeURIComponent(token)}/prep`, { method: 'POST', body });
      toast('Got it. See you at the shoot.');
      setTimeout(() => location.assign('/booked?b=' + encodeURIComponent(token)), 900);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      btn.removeAttribute('aria-busy');
    }
  });
})();

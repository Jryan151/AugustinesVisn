/* =====================================================================
   booked.js — a client's own booking page (/booked?b=<token>). The link is in every email they get.

   Right after Stripe, the deposit may not be confirmed yet (Stripe tells the server a moment later, on its webhook).
   So while it says "hold", this page asks again every 2 seconds, for up to a minute. It never marks anything paid.
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money } = AV;
  const box = document.getElementById('booking');
  const token = new URLSearchParams(location.search).get('b') || '';
  let tries = 0;

  function render(b) {
    const facts = `<dl class="summary">
      <div><dt>Session</dt><dd>${esc(b.package.name)}</dd></div>
      <div><dt>When</dt><dd>${esc(b.when)}</dd></div>
      ${b.payMethod === 'in_person'
        ? `<div><dt>Pay at the shoot, in person</dt><dd class="price">${money(b.balanceCents)}</dd></div>`
        : `<div><dt>Deposit paid</dt><dd class="price">${money(b.depositCents)}</dd></div>
      <div><dt>Balance, before download</dt><dd class="price">${money(b.balanceCents)}</dd></div>`}</dl>`;
    const prep = `<a class="btn ${b.prepped ? '' : 'btn-primary'}" href="/prep/${encodeURIComponent(token)}">${b.prepped ? 'Update the shoot details' : 'Tell me about the shoot'}</a>`;
    switch (b.status) {
      case 'booked': case 'prepped':
        box.innerHTML = `<h1 class="display">You’re booked.</h1><p>Thanks, ${esc(b.name.split(' ')[0])}. A confirmation is on its way to your email.</p>${facts}
          ${b.prepped ? '<p class="muted">Got your shoot details. You can still change them up to the day.</p>' : '<p>One last thing: two minutes on the place, the look and who we’re shooting, so I arrive ready.</p>'}${prep}`;
        break;
      case 'shot': case 'editing':
        box.innerHTML = `<h1 class="display">Your photos are being edited.</h1><p>Your ${esc(b.package.name)} gallery will be ready within ${b.package.turnaround_days} days of the shoot. You’ll get an email with the link.</p>`;
        break;
      case 'delivered':
        box.innerHTML = `<h1 class="display">Your gallery is ready.</h1><p><a class="btn btn-primary" href="${esc(b.galleryUrl)}" rel="noopener">Open your gallery</a></p>`;
        break;
      case 'cancelled':
        box.innerHTML = '<h1 class="display">This session was cancelled.</h1><p class="muted">If that’s a surprise, reply to any email from me.</p><a class="btn" href="/book">Book another time</a>';
        break;
      case 'needs_refund':
        box.innerHTML = '<h1 class="display">That time was taken.</h1><p>Your payment arrived after the time had gone to someone else. You won’t be charged for it: I’ll refund your deposit and email you to find another date.</p>';
        break;
      case 'hold':
        // Zelle: show where to send the deposit. (Card: Stripe confirms on its own, so wait for it.)
        if (b.payMethod === 'zelle' && b.zelle) {
          const until = new Date(b.holdExpiresAt).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
          box.innerHTML = `<h1 class="display">Almost booked.</h1>
            <p>Your ${esc(b.package.name)} session on <b>${esc(b.when)}</b> is held for you until <b>${esc(until)}</b>. Send the deposit by Zelle to confirm it. No fees.</p>
            ${AV.zellePanel({ zelle: b.zelle, amountCents: b.depositCents, ref: b.ref, sent: b.zelleSent, what: 'deposit' })}
            <p class="muted fine">The same details are in your email.</p>`;
          const sent = box.querySelector('[data-zelle-sent]');
          if (sent) sent.addEventListener('click', async () => {
            if (sent.getAttribute('aria-busy') === 'true') return;
            sent.setAttribute('aria-busy', 'true');
            try { render(await AV.api(`/api/bookings/${encodeURIComponent(token)}/zelle-sent`, { method: 'POST', body: {} })); }
            catch (e) { sent.removeAttribute('aria-busy'); AV.toast(e.message, { error: true }); }
          });
          // Checks back now and then, so the page turns into "You're booked" once it's confirmed.
          clearTimeout(window.__avPoll); window.__avPoll = setTimeout(load, 30000);
          return;
        }
        if (++tries < 30) { setTimeout(load, 2000); return; }
        box.innerHTML = '<h1 class="display">Still waiting on the payment.</h1><p class="muted">If you paid, your confirmation email will arrive shortly. If you didn’t finish paying, your time will be released in a few minutes.</p><a class="btn" href="/book">Back to booking</a>';
        break;
      default:
        box.innerHTML = b.payMethod === 'zelle'
          ? '<h1 class="display">This hold has run out.</h1><p class="muted">The deposit didn’t arrive in time, so the time was released. If you did send it, reply to your booking email and it will be sorted out.</p><a class="btn btn-primary" href="/book">Pick a time</a>'
          : '<h1 class="display">This booking has expired.</h1><p class="muted">The payment wasn’t finished in time. Nothing was charged.</p><a class="btn btn-primary" href="/book">Pick a time</a>';
    }
  }

  function load() {
    api('/api/bookings/' + encodeURIComponent(token)).then(render).catch((e) => {
      if (e.status === 0 && ++tries < 30) { setTimeout(load, 3000); return; }
      box.innerHTML = `<h1 class="display">We couldn’t find that booking.</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/">Home</a>`;
    });
  }
  load();
})();

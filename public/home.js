/* home.js — the home page: the bar that appears after the first screen, and the package cards (the last copy at once, then the fresh one). */
(function () {
  'use strict';
  const { esc, money } = AV;
  const list = document.getElementById('package-list');
  const peeking = new Set(); // packages whose photo is showing clean (by slug)
  let shown = ''; // the package list on screen, to skip redrawing the same thing
  document.getElementById('year').textContent = new Date().getFullYear();

  // The package's own photo sits behind its card, at its real shape (so nothing jumps while it loads).
  function photo(img) {
    if (!img) return '';
    return `<img class="pkg-img" data-key="${esc(img.key)}" src="${esc(img.thumb)}" srcset="${esc(img.thumb)} 600w, ${esc(img.web)} 2000w" sizes="(max-width: 600px) 100vw, 360px"
      width="${img.width}" height="${img.height}" alt="" loading="lazy" decoding="async">`;
  }
  // The whole card books (the Book link stretches over it). On a photo card the photo is softly blurred so the text
  // reads over any photo, and "Tap to see picture" clears the text and the blur so the photo shows on its own.
  function card(p) {
    const on = peeking.has(p.slug);
    const peek = p.image ? `<button type="button" class="peek" aria-pressed="${on}"><span class="peek-label">${on ? 'Tap to go back' : 'Tap to see picture'}</span><span class="sr-only"> for ${esc(p.name)}</span></button>` : '';
    // Over the clear photo: a see-through button to this package's portfolio (only when it has shots).
    const more = p.image && p.portfolio_count ? `<a class="see-portfolio" href="/portfolio/${encodeURIComponent(p.slug)}">See portfolio →</a>` : '';
    return `<article class="pkg glass${p.image ? ' has-img' : ''}${on ? ' peeking' : ''}" data-slug="${esc(p.slug)}">${photo(p.image)}
      <h3>${esc(p.name)}</h3>
      <div class="price">${money(p.price_cents)}</div>
      <div class="facts num"><span>${p.minutes} min</span><span>${p.photos} edited photos</span><span>Ready in ${p.turnaround_days} days</span></div>
      <p class="muted">${esc(p.summary)}</p>
      <div class="pkg-foot"><a class="go" href="/book?p=${encodeURIComponent(p.slug)}">Book ${esc(p.name)} →</a>${peek}</div>${more}
    </article>`;
  }

  // One tap shows the photo clean, and it stays that way until the next tap brings the text back. Which photos are
  // showing is remembered, so a refresh of the list (fresh prices arriving, coming back to the tab) never flips them back.
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.peek');
    if (!b) return;
    const pkg = b.closest('.pkg');
    const on = pkg.classList.toggle('peeking');
    if (on) peeking.add(pkg.dataset.slug); else peeking.delete(pkg.dataset.slug);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.peek-label').textContent = on ? 'Tap to go back' : 'Tap to see picture';
    // Keyboard users land on the portfolio button when it appears.
    const more = b.closest('.pkg').querySelector('.see-portfolio');
    if (on && more && e.detail === 0) more.focus();
  });

  // The bar (with its Book button) shows once the name has scrolled out of view, so the first screen stays clean.
  const nav = document.getElementById('nav');
  const hero = document.getElementById('hero');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => nav.classList.toggle('shown', e.intersectionRatio < 0.35), { threshold: [0, 0.35, 1] }).observe(hero);
  } else nav.classList.add('shown');

  AV.cached('packages', '/api/packages', (data, fromCache, err) => {
    list.removeAttribute('aria-busy');
    if (err) { list.innerHTML = `<p class="muted">The packages didn’t load. <a href="">Try again</a>.</p>`; return; }
    if (!data) return;
    // Same packages as on screen: leave the cards alone (no flicker, nothing the visitor opened gets closed).
    const json = JSON.stringify(data.packages);
    if (json === shown) return;
    shown = json;
    list.innerHTML = data.packages.length ? data.packages.map(card).join('') : '<p class="muted">No packages yet.</p>';
  });

})();

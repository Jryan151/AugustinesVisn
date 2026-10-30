/* home.js — the package cards (the last copy at once, then the fresh one) and the background. */
(function () {
  'use strict';
  const { esc, money } = AV;
  const list = document.getElementById('package-list');
  document.getElementById('year').textContent = new Date().getFullYear();

  // The package's own photo sits behind its card, at its real shape (so nothing jumps while it loads).
  function photo(img) {
    if (!img) return '';
    return `<img class="pkg-img" src="${esc(img.thumb)}" srcset="${esc(img.thumb)} 600w, ${esc(img.web)} 2000w" sizes="(max-width: 600px) 100vw, 360px"
      width="${img.width}" height="${img.height}" alt="" loading="lazy" decoding="async">`;
  }
  function card(p) {
    return `<a class="pkg glass${p.image ? ' has-img' : ''}" href="/book?p=${encodeURIComponent(p.slug)}">${photo(p.image)}
      <h3>${esc(p.name)}</h3>
      <div class="price">${money(p.price_cents)}</div>
      <div class="facts num"><span>${p.minutes} min</span><span>${p.photos} edited photos</span><span>Ready in ${p.turnaround_days} days</span></div>
      <p class="muted">${esc(p.summary)}</p>
      <span class="go">Book ${esc(p.name)} →</span>
    </a>`;
  }

  AV.cached('packages', '/api/packages', (data, fromCache, err) => {
    list.removeAttribute('aria-busy');
    if (err) { list.innerHTML = `<p class="muted">The packages didn’t load. <a href="">Try again</a>.</p>`; return; }
    if (!data) return;
    list.innerHTML = data.packages.length ? data.packages.map(card).join('') : '<p class="muted">No packages yet.</p>';
  });

})();

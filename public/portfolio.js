/* =====================================================================
   portfolio.js — a package's example shots (/portfolio/<slug>), reached from the package card's "See portfolio".

   A grid of the shots at their real shapes (nothing jumps as they load). Tapping one opens it large; swipe, the
   arrows or the arrow keys move through them. "Book" goes straight to booking this package.
   ===================================================================== */
(function () {
  'use strict';
  const { api, esc, money } = AV;
  const $ = (id) => document.getElementById(id);
  const slug = location.pathname.split('/').filter(Boolean)[1] || '';
  const viewer = $('viewer');
  let photos = []; let at = 0;

  api('/api/portfolio/' + encodeURIComponent(slug)).then(({ package: p, photos: list }) => {
    photos = list;
    document.title = `${p.name} portfolio · ${document.title.split('· ').pop()}`;
    $('title').textContent = p.name;
    $('sub').innerHTML = `<span class="num">${money(p.price_cents)} · ${p.minutes} min · ${p.photos} edited photos</span>`;
    const href = '/book?p=' + encodeURIComponent(p.slug);
    $('book').href = href; $('book').textContent = `Book ${p.name}`; $('book').hidden = false;
    $('nav-book').href = href;
    $('grid').innerHTML = list.length ? list.map((ph, i) => `<figure>
        <button type="button" class="view" data-i="${i}" aria-label="Open photo ${i + 1} of ${list.length}">
          <img data-key="${esc(ph.key)}" src="${esc(ph.thumb)}" srcset="${esc(ph.thumb)} 600w, ${esc(ph.web)} 2000w" sizes="(max-width: 600px) 100vw, 33vw"
            width="${ph.width}" height="${ph.height}" alt="" loading="${i < 6 ? 'eager' : 'lazy'}" decoding="async">
        </button></figure>`).join('')
      : '<p class="empty">No portfolio photos yet. <a href="' + href + '">Book this package</a> and be the first.</p>';
  }).catch((e) => {
    $('error').textContent = e.status === 404 ? 'That package isn’t available.' : e.message;
    $('error').hidden = false;
  });

  function show(i) {
    at = (i + photos.length) % photos.length;
    const p = photos[at];
    $('viewer-img').src = p.web;
    $('viewer-img').alt = `Photo ${at + 1} of ${photos.length}`;
    $('viewer-count').textContent = `${at + 1} / ${photos.length}`;
    viewer.classList.toggle('single', photos.length < 2);
    // The next one loads while this one is looked at.
    if (photos.length > 1) new Image().src = photos[(at + 1) % photos.length].web;
  }
  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    show(Number(b.dataset.i)); viewer.showModal();
  });
  viewer.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) return show(at + Number(step.dataset.step));
    if (e.target.closest('[data-close]') || e.target === viewer) viewer.close();
  });
  viewer.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') show(at + 1);
    if (e.key === 'ArrowLeft') show(at - 1);
  });
  // Swipe left or right to move; a short tap does nothing extra.
  let x0 = null;
  viewer.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  viewer.addEventListener('pointerup', (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 50 && photos.length > 1) show(at + (dx < 0 ? 1 : -1));
  });
})();

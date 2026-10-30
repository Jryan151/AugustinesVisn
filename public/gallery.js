/* gallery.js — a client's finished photos (/gallery/<token>). Tap a photo to see it large; Download saves the original. */
(function () {
  'use strict';
  const { api, esc } = AV;
  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  const base = '/g/' + encodeURIComponent(token);
  const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';

  api('/api/gallery/' + encodeURIComponent(token)).then((g) => {
    document.getElementById('title').textContent = `${g.name.split(' ')[0]}’s photos`;
    const total = g.photos.reduce((s, p) => s + p.bytes, 0);
    document.getElementById('sub').innerHTML = `${esc(g.package)} · ${esc(g.when)}<br><span class="num">${g.photos.length} photos · ${mb(total)}</span>`;
    const all = document.getElementById('all');
    all.href = base + '/all.zip'; all.hidden = false;
    document.getElementById('grid').innerHTML = g.photos.map((p, i) => `<figure>
      <a class="view" href="${base}/${p.id}/web" target="_blank" rel="noopener">
        <img src="${base}/${p.id}/thumb" width="${p.width}" height="${p.height}" alt="Photo ${i + 1} of ${g.photos.length}" loading="${i < 6 ? 'eager' : 'lazy'}" decoding="async">
      </a>
      <a class="dl" href="${base}/${p.id}/original" download="${esc(p.file_name)}" aria-label="Download photo ${i + 1}">Download</a>
    </figure>`).join('');
  }).catch((e) => {
    const box = document.getElementById('error');
    box.textContent = e.status === 404 ? 'This gallery isn’t ready yet, or the link is wrong. Check the link in your email.' : e.message;
    box.hidden = false;
  });
})();

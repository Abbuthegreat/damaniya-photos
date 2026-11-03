'use strict';
// Damaniya Photos: only photos and videos, grouped by account. Loaded after app.js, which provides sign-in, addresses, the viewer, etc.
(function () {
  if (!PHOTOS) return;
  document.title = 'Damaniya Photos';
  const P = { owner: 'all', kind: 'all', items: [], total: 0, owners: [], loading: false, done: false, gen: 0 };
  let grid = null, chipsEl = null, sumEl = null, sentinel = null, io = null, lastDay = '', hiddenAt = 0;

  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  const dayLabel = t => {
    const n = new Date(), y = new Date(n); y.setDate(n.getDate() - 1); const k = dayKey(t);
    if (k === dayKey(n)) return 'Today'; if (k === dayKey(y)) return 'Yesterday';
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  const hue = s => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const avatar = (name, cls) => h('span', { class: 'ph-av ' + (cls || ''), style: `background:hsl(${hue(name)} 55% 42%)` }, (String(name)[0] || '?').toUpperCase());
  const num = n => Number(n).toLocaleString();

  function parseHash(hh) {
    const o = { owner: 'all', kind: 'all' };
    for (const kv of String(hh || '').replace(/^#!?\/?/, '').split('&')) {
      const i = kv.indexOf('='); if (i < 0) continue; const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (k === 'owner' && v) { try { o.owner = decodeURIComponent(v); } catch { /* ignore */ } }
      if (k === 'kind' && (v === 'photo' || v === 'video')) o.kind = v;
    }
    return o;
  }
  function hashOf(owner, kind) {
    const parts = [];
    if (owner !== 'all') parts.push('owner=' + encodeURIComponent(owner));
    if (kind !== 'all') parts.push('kind=' + kind);
    return parts.length ? '#' + parts.join('&') : '';
  }
  function setFilter(owner, kind) {
    const hh = hashOf(owner, kind);
    if (location.hash === hh || (!hh && !location.hash)) { P.owner = owner; P.kind = kind; go(hh); }
    else location.hash = hh || '#';
  }

  async function loadPage(reset) {
    if (!reset && (P.loading || P.done)) return null;
    const gen = reset ? ++P.gen : P.gen;
    if (reset) { P.items = []; P.done = false; }
    P.loading = true;
    try {
      const x = await api('GET', `/api/photos?owner=${encodeURIComponent(P.owner)}&kind=${P.kind}&offset=${P.items.length}&limit=240`);
      if (gen !== P.gen) return null;
      P.total = x.total; P.owners = x.owners;
      const start = P.items.length;
      P.items.push(...x.items);
      P.done = !x.items.length || P.items.length >= x.total;
      return { start };
    } catch (e) { if (gen === P.gen) { toast(e.message); P.done = true; } return null; }
    finally { if (gen === P.gen) P.loading = false; }
  }

  function tile(it, i) {
    const t = h('button', { class: 'ph-tile', 'aria-label': it.name, onclick: () => viewer(P.items, i) });
    t.append(h('img', { alt: '', loading: 'lazy', decoding: 'async', src: mediaUrl('/api/thumb?path=' + encodeURIComponent(it.path)), onerror: e => { e.target.remove(); t.prepend(h('span', { class: 'ph-fb' }, it.kind === 'video' ? '🎬' : '🖼️')); } }));
    if (it.kind === 'video') t.append(h('span', { class: 'ph-play' }, '▶'));
    if (P.owner === 'all' && it.by) t.append(avatar(it.by, 'ph-by'));
    return t;
  }
  function appendTiles(from) {
    for (let i = from; i < P.items.length; i++) {
      const it = P.items[i], dk = dayKey(it.mtime);
      if (dk !== lastDay) { lastDay = dk; grid.append(h('div', { class: 'ph-day' }, dayLabel(it.mtime))); }
      grid.append(tile(it, i));
    }
    if (!P.items.length) grid.append(h('div', { class: 'ph-empty' }, P.owner === 'all' ? 'No photos or videos yet.' : `No ${P.kind === 'video' ? 'videos' : P.kind === 'photo' ? 'photos' : 'photos or videos'} from ${P.owner} yet.`));
    sentinel.textContent = P.done ? '' : 'Loading…';
    if (io) { io.unobserve(sentinel); if (!P.done) io.observe(sentinel); }
  }
  function renderChips() {
    const tot = P.owners.reduce((a, o) => a + o.photos + o.videos, 0);
    const chip = (key, label, count, av, zero) => h('button', { class: 'ph-chip' + (P.owner === key ? ' on' : '') + (zero ? ' zero' : ''), onclick: () => setFilter(key, P.kind) }, av, h('span', {}, label), h('small', {}, num(count)));
    chipsEl.replaceChildren(chip('all', 'All', tot, h('span', { class: 'ph-av ph-all' }, '▦'), false),
      ...P.owners.map(o => chip(o.name, o.name, o.photos + o.videos, avatar(o.name), !(o.photos + o.videos))));
    const act = chipsEl.querySelector('.on'); if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' });
    const sel = P.owner === 'all' ? { photos: P.owners.reduce((a, o) => a + o.photos, 0), videos: P.owners.reduce((a, o) => a + o.videos, 0) } : (P.owners.find(o => o.name === P.owner) || { photos: 0, videos: 0 });
    sumEl.textContent = (P.owner === 'all' ? 'All accounts' : P.owner) + ' · ' + num(sel.photos) + ' photos · ' + num(sel.videos) + ' videos';
  }

  function menu() {
    const out = async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } S.user = null; location.hash = ''; render(); };
    modal('Damaniya Photos', h('div', { style: 'display:grid;gap:8px' },
      h('p', {}, 'Signed in as ', h('b', {}, S.user.name)),
      h('a', { class: 'btn', href: HOSTED ? LAUNCHER : './' }, '☁ Open Damaniya Cloud (files)'),
      isStandalone() ? null : h('button', { class: 'btn', onclick: () => installApp() }, '📲 Install the Photos app'),
      h('button', { class: 'btn', onclick: out }, 'Sign out')), [{ text: 'Close' }]);
  }

  function shell() {
    chipsEl = h('div', { class: 'ph-chips' });
    sumEl = h('div', { class: 'ph-sum' }, 'Loading…');
    grid = h('div', { class: 'ph-grid' });
    sentinel = h('div', { class: 'ph-more' });
    const seg = (k, label) => h('button', { class: P.kind === k ? 'on' : '', onclick: () => setFilter(P.owner, k) }, label);
    $app.replaceChildren(
      h('div', { class: 'ph-top' },
        h('div', { class: 'ph-bar' }, h('img', { src: 'icons/photos-192.png', alt: '' }), h('h1', {}, 'Damaniya Photos'),
          h('button', { class: 'ph-ib', 'aria-label': 'Refresh', onclick: () => go(location.hash) }, '⟳'),
          h('button', { class: 'ph-user', onclick: menu }, avatar(S.user.name), h('span', {}, S.user.name))),
        chipsEl, h('div', { class: 'ph-seg' }, seg('all', 'All'), seg('photo', 'Photos'), seg('video', 'Videos'))),
      sumEl, grid, sentinel);
    if (io) io.disconnect();
    io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: '900px' }) : null;
    lastDay = '';
  }
  async function more() { const r = await loadPage(false); if (r) appendTiles(r.start); }

  // replace the cloud's screens with the photo screens
  go = async function (hash) {
    document.querySelectorAll('.viewer,.modal').forEach(e => e.remove());
    const o = parseHash(hash); P.owner = o.owner; P.kind = o.kind; S.view = 'photos';
    shell();
    const r = await loadPage(true);
    if (!r) { if (!P.items.length) { grid.append(h('div', { class: 'ph-empty' }, 'Could not load. Pull the refresh button ⟳ to try again.')); sumEl.textContent = ''; } return; }
    // an account that was removed/renamed: fall back to everyone
    if (P.owner !== 'all' && !P.owners.some(x => x.name === P.owner)) { location.hash = '#'; return; }
    renderChips(); appendTiles(0);
  };
  render = function () { if (!S.user) return renderLogin(); go(location.hash); };
  // coming back to the app after a while: show new uploads
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S.user && hiddenAt && Date.now() - hiddenAt > 120000 && !document.querySelector('.viewer,.modal')) go(location.hash);
  });
})();

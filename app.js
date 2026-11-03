'use strict';
const $app = document.getElementById('app');
const S = { user: null, view: 'drive', path: '', items: [], sel: new Set(), mode: 'grid', stats: null, alerts: [], query: '', navOpen: false, tools: {} };
try { S.mode = localStorage.getItem('cd_mode') || 'grid'; } catch { /* ignore */ }
// ---------- where is the PC? ----------
// The app can be served by the PC itself (same address) or be hosted on GitHub Pages and talk to the PC's current address.
const PARAMS = new URLSearchParams(location.search);
const IS_DEV_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const HOSTED = /\.github\.io$/i.test(location.hostname) || (IS_DEV_HOST && !!PARAMS.get('api'));
let API_BASE = '';        // '' = the same address as this page
let MEDIA_TK = null;      // short-lived key so pictures, videos and downloads can load when hosted
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* ignore */ } };
const authHeaders = () => { const k = lsGet('dc-token'); return k ? { Authorization: 'Bearer ' + k } : {}; };
const apiUrl = p => API_BASE + p;
// two apps share this engine: Damaniya Cloud (files) and Damaniya Photos (photos + videos only, screens in photos/photos.js)
const PHOTOS = ((document.querySelector('meta[name=dc-app]') || {}).content) === 'photos';
const APPNAME = PHOTOS ? 'Damaniya Photos' : 'Damaniya Cloud';
const mediaUrl = p => { const u = API_BASE + p; return HOSTED && MEDIA_TK ? u + (u.includes('?') ? '&' : '?') + 'tk=' + MEDIA_TK : u; };

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'role' || k.startsWith('aria-') || k.startsWith('data-')) el.setAttribute(k, v);
    else el[k] = v;
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
async function api(method, url, body, _retried) {
  let r;
  try { r = await fetch(apiUrl(url), { method, headers: Object.assign({ 'X-Requested-With': 'cloud' }, authHeaders(), body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }); }
  catch { if (HOSTED && !_retried && await reconnect()) return api(method, url, body, true); throw new Error('Cannot reach Damaniya Cloud. Check your internet connection and try again.'); }
  const j = await r.json().catch(() => ({}));
  if (j && j.token) { lsSet('dc-token', j.token); await refreshMedia(); }
  if (/^\/api\/logout(-all)?$/.test(url)) { lsDel('dc-token'); MEDIA_TK = null; }
  if (r.status === 401 && S.user && !url.includes('/login')) { lsDel('dc-token'); S.user = null; render(); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 3);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
const DT = { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
function fmtDT(t) { return t ? new Date(t).toLocaleString(undefined, DT) : '—'; }
function fmtDate(t) { return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
const ICON = { folder: '📁', image: '🖼️', imageconv: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', archive: '🗜️', office: '📊', file: '📄' };
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const fileUrl = (p, dl) => mediaUrl('/api/file?path=' + encodeURIComponent(p) + (dl ? '&download=1' : ''));
const join = (a, b) => a ? a + '/' + b : b;
const canEdit = () => S.user && (S.user.role === 'admin' || S.user.role === 'editor');
const isAdminUser = () => S.user && S.user.role === 'admin';
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
function download(url) { const a = h('a', { href: url }); document.body.append(a); a.click(); a.remove(); }
let toastT;
function toast(msg) { document.querySelectorAll('.toast').forEach(e => e.remove()); const t = h('div', { class: 'toast' }, msg); document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4500); }
function modal(title, body, buttons) {
  const m = h('div', { class: 'modal', onmousedown: e => { if (e.target === m) m.remove(); } }, h('div', { class: 'card' }, h('h2', {}, title), body, h('div', { class: 'row-btns' }, buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onclick: async () => { if (b.run) { const ok = await b.run(m); if (ok === false) return; } m.remove(); } }, b.text)))));
  document.body.append(m);
  const inp = m.querySelector('input:not([type=checkbox])'); if (inp) { inp.focus(); inp.select(); }
  return m;
}
function ask(title, label, value, okText) {
  return new Promise(res => {
    const inp = h('input', { type: 'text', value: value || '', onkeydown: e => { if (e.key === 'Enter') ok.click(); } });
    let ok;
    const m = modal(title, h('div', {}, label ? h('p', { class: 'muted' }, label) : null, inp), [{ text: 'Cancel', run: () => res(null) }, { text: okText || 'OK', cls: 'primary', run: () => res(inp.value.trim()) }]);
    ok = m.querySelector('.primary');
  });
}
function confirmBox(title, text, okText, danger) {
  return new Promise(res => modal(title, h('p', {}, text), [{ text: 'Cancel', run: () => res(false) }, { text: okText, cls: danger ? 'danger' : 'primary', run: () => res(true) }]));
}

// ---------- finding the PC when the app is hosted on GitHub ----------
const K_PASS = 'dc-pass', K_LAST = 'dc-last', K_FIXED = 'dc-fixed';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decryptAddr(blob, pass) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(blob.salt), iterations: blob.iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, key, b64d(blob.ct))));
}
// an address counts as "answering" only if it really delivers its own icon (an error page from a dead tunnel is not an image)
function reachable(url, ms) {
  return new Promise(resolve => {
    const img = new Image(); let done = false;
    const fin = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => fin(false), ms || 10000);
    img.onload = () => fin(img.naturalWidth > 0); img.onerror = () => fin(false);
    img.src = url.replace(/\/$/, '') + '/favicon.png?ping=' + Date.now();
  });
}
// returns: 'ok' | 'needkey' | 'badkey' | 'down'
async function locate(report) {
  const last = lsGet(K_LAST);
  if (last && await reachable(last, 3500)) { API_BASE = last; return 'ok'; }
  let blob = null;
  try { const r = await fetch('address.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) blob = await r.json(); report.list = r.ok ? 'ok' : 'error ' + r.status; } catch { report.list = 'could not load'; }
  let a = null;
  if (blob) {
    const pass = lsGet(K_PASS);
    if (!pass) return 'needkey';
    try { a = await decryptAddr(blob, pass); } catch { lsDel(K_PASS); return 'badkey'; }
  }
  const fixed = (a && a.fixed) || lsGet(K_FIXED);
  if (fixed) lsSet(K_FIXED, fixed);
  if (a && a.url) { if (await reachable(a.url, 10000)) { lsSet(K_LAST, a.url); API_BASE = a.url; return 'ok'; } report.fast = 'no answer from the fast address'; }
  if (fixed && await reachable(fixed, 30000)) { lsSet(K_LAST, fixed); API_BASE = fixed; return 'ok'; }
  return 'down';
}
let connecting = null;
function reconnect() {
  if (!connecting) connecting = (async () => { try { for (let i = 0; i < 3; i++) { if ((await locate({})) === 'ok') return true; await sleep(4000); } return false; } finally { connecting = null; } })();
  return connecting;
}
function connectScreen(inner) {
  const app = document.getElementById('app');
  app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card login', style: 'text-align:center' }, h('img', { class: 'logo', src: 'favicon.svg', alt: '' }), h('h1', {}, APPNAME), inner)));
}
async function connectHosted() {
  // an invitation link looks like .../damaniya-cloud/#key=XXXX-XXXX-XXXX-XXXX : remember the key, then tidy the address bar
  const inv = /[#&]key=([A-Za-z0-9-]+)/.exec(location.hash);
  const wantInstall = /(^|[#&])install(&|$)/.test(location.hash);
  if (inv) { lsSet(K_PASS, inv[1].toUpperCase()); try { history.replaceState(null, '', location.pathname + location.search + location.hash.replace(/[#&]key=[A-Za-z0-9-]+/, '').replace(/^&/, '#')); } catch { /* ignore */ } }
  if (wantInstall && !isStandalone()) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ } setTimeout(installApp, 600); }
  for (let attempt = 0; ; attempt++) {
    connectScreen(h('div', {}, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, attempt ? 'Your cloud is restarting… trying again (' + attempt + ')' : 'Finding your cloud…')));
    const report = {};
    const r = await locate(report);
    if (r === 'ok') return true;
    if (r === 'needkey' || r === 'badkey') {
      await new Promise(done => {
        const inp = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX', style: 'text-align:center' });
        const go1 = () => { const v = inp.value.trim().toUpperCase(); if (v) { lsSet(K_PASS, v); done(); } };
        inp.onkeydown = e => { if (e.key === 'Enter') go1(); };
        connectScreen(h('div', { style: 'display:grid;gap:10px' }, h('p', {}, 'Enter your Damaniya passphrase.', h('br'), 'You only need to do this once on this device.'), inp, r === 'badkey' ? h('p', { class: 'err' }, 'That passphrase does not match.') : null, h('button', { class: 'btn primary', onclick: go1 }, 'Open')));
      });
      continue;
    }
    if (attempt < 5) { await sleep(8000); continue; }
    await new Promise(done => connectScreen(h('div', { style: 'display:grid;gap:10px' }, h('p', {}, h('b', {}, 'Your cloud is not answering right now.')), h('p', { class: 'muted' }, 'The PC may be off, restarting, or offline. This usually fixes itself in a minute or two.'), h('button', { class: 'btn primary', onclick: () => done() }, 'Try again'))));
    attempt = -1;
  }
}
let mediaTimer = null;
async function refreshMedia() {
  if (!HOSTED) return;
  try {
    const r = await fetch(apiUrl('/api/media-token'), { method: 'POST', headers: Object.assign({ 'X-Requested-With': 'cloud' }, authHeaders()) });
    if (r.ok) MEDIA_TK = (await r.json()).token;
  } catch { /* ignore */ }
  if (!mediaTimer) mediaTimer = setInterval(refreshMedia, 40 * 60e3);
}
// ---------- boot ----------
let statsTimer = null;
async function boot() {
  if (HOSTED) await connectHosted();
  const s = await api('GET', '/api/session');
  applySession(s);
  if (S.user) await refreshMedia();
  if (S.user) { await go(location.hash); } else render();
}
function applySession(s) { S.user = s.user; S.needsSetup = s.needsSetup; S.setupBlocked = s.setupBlocked; S.publicUrl = s.publicUrl; S.fixedUrl = s.fixedUrl; S.tools = s.tools || {}; S.serverAdmin = s.isAdmin; }
window.addEventListener('hashchange', () => { if (S.user) go(location.hash); });
function hashFor() { return S.view === 'drive' ? '#/' + enc(S.path) : '#!' + S.view; }
const ADMIN_VIEWS = ['storage', 'users', 'history', 'activity'];
async function go(hash) {
  S.sel.clear();
  if (hash.startsWith('#!')) { S.view = hash.slice(2); if (!['trash', ...ADMIN_VIEWS].includes(S.view)) S.view = 'drive'; }
  else { S.view = 'drive'; S.path = decodeURIComponent(hash.replace(/^#\/?/, '')); }
  if (ADMIN_VIEWS.includes(S.view) && !isAdminUser()) S.view = 'drive';
  await load();
}
function nav(view, path) {
  S.view = view; if (path != null) S.path = path; S.navOpen = false;
  const hh = hashFor();
  if (location.hash === hh) go(hh); else location.hash = hh;
}
async function load() {
  try {
    if (S.view === 'drive') S.items = (await api('GET', '/api/list?path=' + encodeURIComponent(S.path))).items;
    else if (S.view === 'trash') S.items = (await api('GET', '/api/trash')).items;
    else if (S.view === 'search') S.items = (await api('GET', '/api/search?q=' + encodeURIComponent(S.query))).items;
    refreshStats();
  } catch (e) { toast(e.message); if (S.view === 'drive' && S.path) { S.path = ''; S.items = []; return nav('drive', ''); } S.items = []; }
  render();
  clearInterval(statsTimer); statsTimer = setInterval(refreshStats, 30000);
}
async function refreshStats() {
  try { const x = await api('GET', '/api/stats'); S.stats = x; S.alerts = x.alerts || []; const q = document.getElementById('quota'); if (q) q.replaceWith(quotaEl()); const a = document.getElementById('alerts'); if (a) a.replaceWith(alertsEl()); } catch { /* ignore */ }
}

// ---------- shared pieces ----------
function quotaEl() {
  const st = S.stats;
  if (!st) return h('div', { class: 'quota', id: 'quota' });
  const used = st.total - st.free, pct = st.total ? used / st.total * 100 : 0;
  return h('div', { class: 'quota', id: 'quota' }, h('div', { class: 'bar ' + (pct > 90 ? 'bad' : pct > 75 ? 'warn' : '') }, h('i', { style: 'width:' + pct + '%' })), h('div', { class: 'muted', style: 'margin-top:6px' }, `${fmtSize(used)} of ${fmtSize(st.total)} used`), h('div', { class: 'muted' }, `${st.disks} disk${st.disks === 1 ? '' : 's'} in your cloud`));
}
function alertsEl() {
  const box = h('div', { id: 'alerts' });
  for (const a of S.alerts) {
    box.append(h('div', { class: 'banner ' + (a.level === 'bad' ? '' : 'warn'), role: 'alert' },
      a.missing ? `⚠ Disk ${a.id} is NOT detected! ` : a.level === 'bad' ? `⚠ ${a.id} is in BAD health. ` : `⚠ ${a.id} needs attention. `, a.reasons.join(' · '),
      isAdminUser() ? h('button', { class: 'btn small', style: 'margin-left:10px', onclick: () => nav('storage') }, 'Open Storage & Health') : h('span', { style: 'font-weight:400' }, ' Please tell the administrator.')));
  }
  return box;
}

// ---------- render ----------
function render() {
  storageGen++; clearInterval(storageTimer);
  if (!S.user) return renderLogin();
  const navItem = (v, icon, label) => h('button', { class: 'nav' + (S.view === v ? ' active' : ''), onclick: () => nav(v, v === 'drive' ? '' : null) }, icon, label);
  const searchBox = h('input', { type: 'search', placeholder: 'Search in your cloud', value: S.view === 'search' ? S.query : '', onkeydown: e => { if (e.key === 'Enter') { S.query = e.target.value.trim(); if (S.query.length >= 2) { S.view = 'search'; load(); } else if (!S.query) nav('drive', ''); } } });
  const shell = h('div', { class: 'shell' },
    h('header', {}, h('button', { class: 'menu-btn', onclick: () => { S.navOpen = !S.navOpen; document.querySelector('aside').classList.toggle('open', S.navOpen); } }, '☰'),
      h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('span', {}, 'Damaniya Cloud')),
      h('div', { class: 'search' }, searchBox), h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: userMenu }, '👤 ' + S.user.name)),
    h('aside', { class: S.navOpen ? 'open' : '' },
      canEdit() ? h('button', { class: 'new-btn', onclick: e => newMenu(e) }, '＋  New') : null,
      navItem('drive', '📂 ', 'My Drive'), navItem('trash', '🗑️ ', 'Trash'),
      isAdminUser() ? [navItem('storage', '💽 ', 'Storage & Health'), navItem('history', '🗂️ ', 'Disk History'), navItem('activity', '🕵️ ', 'Activity Log'), navItem('users', '👥 ', 'People')] : null,
      quotaEl()),
    h('main', { id: 'main' }, alertsEl()));
  $app.replaceChildren(shell);
  const main = document.getElementById('main');
  if (S.view === 'storage') return renderStorage(main);
  if (S.view === 'users') return renderUsers(main);
  if (S.view === 'history') return renderHistory(main);
  if (S.view === 'activity') return renderActivity(main);
  renderFiles(main);
}
function renderLogin(needCode) {
  const u = h('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const p = h('input', { type: 'password', placeholder: S.needsSetup ? 'Choose a strong password (10+ characters)' : 'Password', autocomplete: S.needsSetup ? 'new-password' : 'current-password' });
  const c = h('input', { type: 'text', inputMode: 'numeric', placeholder: '6-digit verification code', autocomplete: 'one-time-code', class: 'hidden', maxLength: 7 });
  const err = h('div', { class: 'err' });
  const submit = async () => {
    err.textContent = '';
    try {
      const r = await api('POST', S.needsSetup ? '/api/setup' : '/api/login', { username: u.value.trim(), password: p.value, code: c.value });
      if (r.need2fa) { c.classList.remove('hidden'); c.focus(); err.textContent = 'Enter the code from your authenticator app.'; return; }
      S.needsSetup = false; applySession(await api('GET', '/api/session')); await go(location.hash);
    } catch (e) { err.textContent = e.message; }
  };
  for (const i of [u, p, c]) i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card login' },
    h('img', { class: 'logo', src: 'favicon.svg', alt: '' }), h('h1', {}, APPNAME), h('h2', { style: 'margin:0;font-size:16px;font-weight:500' }, S.needsSetup ? 'Create your admin account' : 'Sign in'),
    S.needsSetup ? h('div', { class: S.setupBlocked ? 'err' : 'muted' }, S.setupBlocked ? 'First-time setup is only allowed on the PC itself or your home Wi-Fi, not over the internet.' : 'First-time setup. This account will be the owner.') : null,
    u, p, c, err, h('button', { class: 'btn primary', onclick: submit }, S.needsSetup ? 'Create account' : 'Sign in'),
    isStandalone() ? null : h('button', { class: 'btn small', style: 'justify-self:center', onclick: installApp }, '📲 Install the app on this device'))));
  u.focus();
}

// ---------- files view ----------
function pathOf(it) { return it.path || join(S.path, it.name); }
const isFolder = it => it.dir || it.kind === 'folder';
function selectedItems() { return S.items.filter(i => S.sel.has(S.view === 'trash' ? i.id : pathOf(i))); }
function renderFiles(main) {
  const tb = h('div', { class: 'toolbar' });
  if (S.view === 'drive') {
    const parts = S.path ? S.path.split('/') : [];
    const c = h('div', { class: 'crumbs' }, h('button', { onclick: () => nav('drive', '') }, 'My Drive'));
    parts.forEach((p, i) => c.append(h('span', {}, '›'), h('button', { onclick: () => nav('drive', parts.slice(0, i + 1).join('/')) }, p)));
    tb.append(c);
  } else if (S.view === 'trash') {
    tb.append(h('div', { class: 'crumbs' }, h('button', {}, 'Trash')), h('span', { class: 'muted' }, 'Deleted items stay here until an admin empties the trash.'));
    if (isAdminUser() && S.items.length) tb.append(h('button', { class: 'btn danger small', onclick: async () => { if (await confirmBox('Empty trash?', 'Everything in the trash will be permanently deleted. This cannot be undone.', 'Delete forever', true)) { await api('POST', '/api/trash/purge', { all: true }); toast('Trash emptied'); load(); } } }, 'Empty trash'));
  } else tb.append(h('div', { class: 'crumbs' }, h('button', {}, `Search: "${S.query}"`)));
  tb.append(h('div', { class: 'spacer', style: 'flex:1' }));
  if (S.sel.size) {
    const bar = h('div', { class: 'sel-bar' }, `${S.sel.size} selected`);
    const mk = (t, f, cls) => bar.append(h('button', { class: 'btn small ' + (cls || ''), onclick: f }, t));
    if (S.view === 'trash') { mk('Restore', async () => { await api('POST', '/api/trash/restore', { ids: [...S.sel] }); toast('Restored'); S.sel.clear(); load(); }); if (isAdminUser()) mk('Delete forever', async () => { if (await confirmBox('Delete forever?', 'This cannot be undone.', 'Delete forever', true)) { await api('POST', '/api/trash/purge', { ids: [...S.sel] }); S.sel.clear(); load(); } }, 'danger'); }
    else {
      const sel = selectedItems(), one = sel.length === 1 ? sel[0] : null;
      if (one && !isFolder(one)) mk('Download', () => download(fileUrl(pathOf(one), true)));
      if (S.tools.zip && (sel.length > 1 || (one && isFolder(one)))) mk('Download as zip', () => zipDownload(sel));
      if (canEdit()) {
        if (one) mk('Rename', () => renameItem(one));
        if (S.tools.zip) mk('Compress', () => compressSel(sel));
        if (one && one.kind === 'archive' && S.tools.archive) mk('Extract', () => extractDialog(one));
        mk('Move', moveSel); mk('Delete', deleteSel, 'danger');
      }
    }
    bar.append(h('button', { class: 'btn small', onclick: () => { S.sel.clear(); render(); } }, '✕'));
    tb.append(bar);
  }
  tb.append(h('button', { class: 'btn small', title: 'Toggle view', onclick: () => { S.mode = S.mode === 'grid' ? 'list' : 'grid'; try { localStorage.setItem('cd_mode', S.mode); } catch { /* ignore */ } render(); } }, S.mode === 'grid' ? '☰ List' : '▦ Grid'));
  main.append(tb);
  if (S.view === 'drive' && !S.user.totp && isAdminUser() && !sessionStorage.getItem('cd_2fa_nag')) main.append(h('div', { class: 'banner info' }, '🔐 For better security, turn on two-step verification. ', h('button', { class: 'btn small primary', onclick: twoFactorDialog }, 'Set up now'), ' ', h('button', { class: 'btn small', onclick: e => { try { sessionStorage.setItem('cd_2fa_nag', '1'); } catch { /* ignore */ } e.target.closest('.banner').remove(); } }, 'Later')));
  if (!S.items.length) {
    main.append(h('div', { class: 'empty' }, h('div', { style: 'font-size:60px' }, S.view === 'trash' ? '🗑️' : '📂'), S.view === 'trash' ? 'Trash is empty' : S.view === 'search' ? 'No matches' : canEdit() ? 'This folder is empty. Drag files here or press New → File upload.' : 'This folder is empty.'));
  } else if (S.mode === 'grid') {
    const folders = S.items.filter(isFolder), files = S.items.filter(i => !isFolder(i));
    if (folders.length) { main.append(h('h3', { class: 'sec' }, 'Folders'), h('div', { class: 'grid' }, folders.map(tile))); }
    if (files.length) { main.append(h('h3', { class: 'sec' }, 'Files'), h('div', { class: 'grid' }, files.map(tile))); }
  } else {
    const trash = S.view === 'trash';
    const rows = S.items.map(it => {
      const p = trash ? it.id : pathOf(it), isF = isFolder(it);
      const by = trash ? it.uploadedBy : it.by, at = trash ? it.uploadedAt : it.at;
      return h('tr', { class: 'row' + (S.sel.has(p) ? ' sel' : ''), onclick: e => rowClick(e, it), oncontextmenu: e => { e.preventDefault(); if (!S.sel.has(p)) { S.sel.clear(); S.sel.add(p); } ctxMenu(e, it); } },
        h('td', {}, h('input', { type: 'checkbox', checked: S.sel.has(p), onclick: e => { e.stopPropagation(); toggleSel(p); } })),
        h('td', { class: 'nm-cell' }, (ICON[it.kind] || '📄') + '  ' + it.name),
        h('td', {}, by || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'muted' }, isF ? '—' : fmtSize(it.size)),
        h('td', { class: 'muted' }, fmtDT(trash ? it.deletedAt : it.mtime)),
        h('td', { class: 'muted' }, at ? fmtDT(at) : '—'),
        trash ? h('td', { class: 'muted' }, it.by || '') : h('td', { class: 'muted' }, it.disk || ''),
        h('td', {}, trash ? null : moreBtn(it)));
    });
    main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('tr', {}, h('th', {}), h('th', {}, 'Name'), h('th', {}, 'Uploaded by'), h('th', {}, 'Size'), h('th', {}, trash ? 'File date' : 'Modified'), h('th', {}, 'Uploaded on'), h('th', {}, trash ? 'Deleted by' : 'Disk'), h('th', {})), rows)));
  }
  if (S.view === 'drive' && canEdit()) setupDrop(main);
}
function tile(it) {
  const trash = S.view === 'trash';
  const p = trash ? it.id : pathOf(it), isF = isFolder(it);
  const cls = 'tile' + (isF ? ' folder' : '') + (S.sel.has(p) ? ' sel' : '');
  const by = trash ? it.uploadedBy : it.by, at = trash ? it.uploadedAt : it.at;
  const tip = `${it.name}\n${isF ? 'Folder' : fmtSize(it.size)}\nUploaded by: ${by || 'unknown'}\nUploaded on: ${at ? fmtDT(at) : '—'}\nModified: ${fmtDT(trash ? it.deletedAt : it.mtime)}`;
  const chk = h('input', { type: 'checkbox', class: 'chk', checked: S.sel.has(p), onclick: e => { e.stopPropagation(); toggleSel(p); } });
  const ev = { onclick: e => rowClick(e, it), oncontextmenu: e => { e.preventDefault(); if (!S.sel.has(p)) { S.sel.clear(); S.sel.add(p); render(); } ctxMenu(e, it); } };
  const more = trash ? null : moreBtn(it);
  const sub = h('div', { class: 'sub' }, by ? '👤 ' + by + ' · ' : '', fmtDate(at || it.mtime));
  if (isF) return h('div', Object.assign({ class: cls, title: tip }, ev), chk, h('span', { class: 'ico' }, '📁'), h('span', { class: 'fcol' }, h('span', { class: 'nm', style: 'padding:0' }, it.name), sub), more);
  const thumb = h('div', { class: 'thumb' });
  if (['image', 'imageconv', 'video'].includes(it.kind) && !trash) thumb.append(h('img', { loading: 'lazy', alt: '', src: mediaUrl('/api/thumb?path=' + encodeURIComponent(p)), onerror: e => { e.target.replaceWith(document.createTextNode(ICON[it.kind])); } }));
  else thumb.append(ICON[it.kind] || '📄');
  return h('div', Object.assign({ class: cls, title: tip }, ev), chk, thumb, it.kind === 'video' ? h('span', { class: 'play' }, '▶') : null, h('div', { class: 'nm' }, it.name), sub, more);
}
function toggleSel(p) { if (S.sel.has(p)) S.sel.delete(p); else S.sel.add(p); render(); }
function rowClick(e, it) {
  const p = S.view === 'trash' ? it.id : pathOf(it);
  if (S.view === 'trash') return toggleSel(p);
  if (e.ctrlKey || e.metaKey || S.sel.size) return toggleSel(p);
  open(it);
}
function open(it) {
  if (isFolder(it)) return nav('drive', pathOf(it));
  if (S.view === 'trash') return;
  const list = S.items.filter(i => !isFolder(i));
  viewer(list, list.findIndex(i => pathOf(i) === pathOf(it)));
}
function moreBtn(it) {
  const p = pathOf(it);
  return h('button', { class: 'more', title: 'More actions', onclick: e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); const pos = { clientX: r.left, clientY: r.bottom }; if (!S.sel.has(p) || S.sel.size > 1) { S.sel.clear(); S.sel.add(p); render(); } ctxMenu(pos, it); } }, '⋮');
}
function ctxMenu(e, it) {
  closePops();
  const p = pathOf(it), isF = isFolder(it);
  const items = [];
  if (S.view === 'trash') { items.push(['Restore', async () => { await api('POST', '/api/trash/restore', { ids: [it.id] }); load(); }]); }
  else {
    items.push(['Open', () => open(it)]);
    if (!isF) items.push(['Download', () => download(fileUrl(p, true))]);
    else if (S.tools.zip) items.push(['Download as zip', () => zipDownload([it])]);
    if (S.view === 'search') items.push(['Show in folder', () => nav('drive', p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')]);
    if (canEdit()) {
      items.push(null);
      if (it.kind === 'archive' && S.tools.archive) items.push(['Extract…', () => extractDialog(it)]);
      if (S.tools.zip) items.push(['Compress to zip', () => compressSel([it])]);
      items.push(['Rename', () => renameItem(it)], ['Move to…', moveSel], ['Delete', deleteSel]);
    }
  }
  popup(items, e.clientX, e.clientY);
}
let popOff = null;
function popup(items, x, y) {
  closePops();
  const m = h('div', { class: 'pop' }, items.map(i => i ? h('button', { onclick: () => { closePops(); i[1](); } }, i[0]) : h('hr')));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'; m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  const off = e => { if (!m.contains(e.target)) closePops(); };
  popOff = off;
  setTimeout(() => { if (popOff === off) document.addEventListener('pointerdown', off, true); }, 0);
}
function closePops() {
  document.querySelectorAll('.pop').forEach(e => e.remove());
  if (popOff) { document.removeEventListener('pointerdown', popOff, true); popOff = null; }
}
function newMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const dir = S.view === 'drive' ? S.path : '';
  popup([['📁  New folder', async () => { const n = await ask('New folder', '', 'Untitled folder', 'Create'); if (n) { try { await api('POST', '/api/mkdir', { path: join(dir, n) }); load(); } catch (x) { toast(x.message); } } }],
    null, ['⬆️  File upload', () => pick(false)], ['📤  Folder upload', () => pick(true)]], r.left, r.bottom + 4);
}
function pick(folder) {
  const inp = h('input', { type: 'file', multiple: true, style: 'position:fixed;left:-9999px;opacity:0' }); if (folder) inp.webkitdirectory = true;
  document.body.append(inp);
  inp.onchange = () => { uploadFiles([...inp.files].map(f => ({ file: f, rel: folder ? f.webkitRelativePath : f.name }))); setTimeout(() => inp.remove(), 60000); };
  inp.addEventListener('cancel', () => inp.remove());
  inp.click();
}
async function renameItem(it) {
  const n = await ask('Rename', '', it.name, 'Rename'); if (!n || n === it.name) return;
  try { await api('POST', '/api/rename', { path: pathOf(it), newName: n }); S.sel.clear(); load(); } catch (e) { toast(e.message); }
}
async function deleteSel() {
  const paths = [...S.sel];
  if (!await confirmBox('Move to trash?', `${paths.length} item${paths.length > 1 ? 's' : ''} will be moved to the trash. An admin can restore them.`, 'Move to trash', true)) return;
  try { await api('POST', '/api/delete', { paths }); S.sel.clear(); toast('Moved to trash'); load(); } catch (e) { toast(e.message); }
}
async function moveSel() {
  const dest = await ask('Move to folder', 'Type the destination folder path (empty = My Drive root), e.g. Photos/2024', S.path, 'Move');
  if (dest == null) return;
  try { await api('POST', '/api/move', { paths: [...S.sel], dest: dest.replace(/^\/+|\/+$/g, '') }); S.sel.clear(); toast('Moved'); load(); } catch (e) { toast(e.message); }
}
function zipDownload(items) { download(mediaUrl('/api/zip?' + items.map(i => 'p=' + encodeURIComponent(pathOf(i))).join('&'))); }
async function compressSel(items) {
  const def = items.length === 1 ? items[0].name : 'Archive';
  const n = await ask('Compress to zip', 'Name of the new zip file (saved in this folder)', def.replace(/\.[^.]+$/, ''), 'Compress'); if (!n) return;
  try { const r = await api('POST', '/api/compress', { paths: items.map(pathOf), name: n }); S.sel.clear(); watchTask(r.taskId, 'Creating zip'); } catch (e) { toast(e.message); }
}
function extractDialog(it, pw) {
  const def = it.name.replace(/\.(tar\.(gz|bz2|xz|zst|lz)|tgz|tbz2?|txz)$/i, '').replace(/\.[^.]+$/, '');
  const dest = h('input', { type: 'text', value: join(S.view === 'drive' ? S.path : (pathOf(it).includes('/') ? pathOf(it).slice(0, pathOf(it).lastIndexOf('/')) : ''), def) });
  const pwd = h('input', { type: 'password', placeholder: 'Password (only if the archive has one)', value: pw || '' });
  modal('Extract ' + it.name, h('div', { style: 'display:grid;gap:8px' }, h('p', { class: 'muted' }, 'Files are extracted into this folder (it is created for you):'), dest, pwd),
    [{ text: 'Cancel' }, { text: 'Extract', cls: 'primary', run: async () => { try { const r = await api('POST', '/api/extract', { path: pathOf(it), dest: dest.value.trim().replace(/^\/+|\/+$/g, ''), password: pwd.value }); S.sel.clear(); watchTask(r.taskId, 'Extracting ' + it.name); } catch (e) { toast(e.message); return false; } } }]);
}
function watchTask(id, title) {
  const step = h('div', {}, 'Starting…'), bar = h('i', { style: 'width:0' }), log = h('div', { class: 'err' });
  modal(title, h('div', { style: 'display:grid;gap:8px' }, step, h('div', { class: 'bar' }, bar), log), [{ text: 'Hide' }]);
  const t = setInterval(async () => {
    try {
      const j = await api('GET', '/api/task?id=' + id);
      step.textContent = j.step + (j.state === 'running' ? ` — ${j.percent}%` : ''); bar.style.width = j.percent + '%'; log.textContent = j.log.join(' ');
      if (j.state !== 'running') { clearInterval(t); toast(j.state === 'done' ? '✓ ' + j.step : 'Failed: ' + j.log.join(' ')); if (j.state === 'done' && S.view === 'drive') load(); }
    } catch { clearInterval(t); }
  }, 1500);
}

// ---------- drag & drop / upload ----------
function setupDrop(main) {
  let depth = 0, ov = null;
  main.ondragenter = e => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); if (depth++ === 0) { ov = h('div', { class: 'drop' }, 'Drop to upload'); main.append(ov); } };
  main.ondragover = e => e.preventDefault();
  main.ondragleave = () => { if (--depth <= 0) { depth = 0; ov && ov.remove(); } };
  main.ondrop = async e => {
    e.preventDefault(); depth = 0; ov && ov.remove();
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) await new Promise(r => entry.file(f => { out.push({ file: f, rel: prefix + f.name }); r(); }, r));
      else if (entry.isDirectory) {
        const rd = entry.createReader(); let batch;
        do { batch = await new Promise(r => rd.readEntries(r, () => r([]))); for (const c of batch) await walk(c, prefix + entry.name + '/'); } while (batch.length);
      }
    };
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    for (const en of entries) await walk(en, '');
    if (out.length) uploadFiles(out);
  };
}
const Q = { list: [], running: 0, panel: null };
function uploadFiles(files) {
  const dir = S.path;
  for (const f of files) Q.list.push({ file: f.file, rel: f.rel, dir, state: 'wait', pct: 0, el: null });
  uploadPanel(); pump();
}
function uploadPanel() {
  if (!Q.panel) { Q.panel = h('div', { class: 'uploads' }, h('div', { class: 'hd' }, h('span', { id: 'uph' }, 'Uploading'), h('button', { class: 'btn small', onclick: () => { Q.panel.remove(); Q.panel = null; Q.list = Q.list.filter(x => x.state === 'wait' || x.state === 'up'); } }, '✕')), h('div', { class: 'body' })); document.body.append(Q.panel); }
  const body = Q.panel.querySelector('.body');
  for (const u of Q.list) if (!u.el) { u.el = h('div', { class: 'u' }, h('div', {}, u.rel), h('div', { class: 'bar', style: 'margin-top:4px' }, h('i', { style: 'width:0' })), h('div', { class: 'muted', style: 'margin-top:2px' }, 'Waiting…')); body.append(u.el); }
  const done = Q.list.filter(x => x.state === 'done').length;
  document.getElementById('uph').textContent = `Uploading ${done}/${Q.list.length}`;
}
// big files go up in 32 MB pieces: works through the internet tunnel (100 MB per request limit) and retries a piece if the connection hiccups
const BIG_FILE = 64 * 1024 * 1024;
async function uploadChunked(u, dir, name, bar, txt, fin) {
  const sendChunk = (id, offset, blob) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', apiUrl(`/api/upload/chunk?id=${id}&offset=${offset}`));
    x.setRequestHeader('X-Requested-With', 'cloud'); for (const [hk, hv] of Object.entries(authHeaders())) x.setRequestHeader(hk, hv);
    x.upload.onprogress = e => { const done = offset + e.loaded; u.pct = done / u.file.size * 100; bar().style.width = u.pct + '%'; txt().textContent = `${fmtSize(done)} / ${fmtSize(u.file.size)}`; };
    x.onload = () => x.status === 200 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).error; } catch { return 'HTTP ' + x.status; } })()));
    x.onerror = () => reject(new Error('Network error'));
    x.send(blob);
  });
  let id = null;
  try {
    const s = await api('POST', '/api/upload/start', { dir, name, size: u.file.size, mtime: u.file.lastModified });
    id = s.id;
    for (let off = 0; off < u.file.size; off += s.chunk) {
      const blob = u.file.slice(off, Math.min(off + s.chunk, u.file.size));
      let tries = 0;
      for (;;) { try { await sendChunk(id, off, blob); break; } catch (e) { if (++tries >= 6) throw e; txt().textContent = `Connection problem, retrying (${tries}/5)…`; await new Promise(r => setTimeout(r, 1500 * tries)); } }
    }
    await api('POST', '/api/upload/finish', { id });
    fin(true);
  } catch (e) { if (id) api('POST', '/api/upload/abort', { id }).catch(() => {}); fin(false, e.message); }
}
function pump() {
  while (Q.running < 3) {
    const u = Q.list.find(x => x.state === 'wait'); if (!u) break;
    u.state = 'up'; Q.running++;
    const parts = u.rel.split('/'), name = parts.pop(), dir = [u.dir, ...parts].filter(Boolean).join('/');
    const bar = () => u.el.querySelector('.bar i'), txt = () => u.el.lastChild;
    const fin = (ok, msg) => { u.state = ok ? 'done' : 'fail'; Q.running--; txt().textContent = ok ? 'Done ✓' : '⚠ ' + msg; if (ok) bar().style.width = '100%'; uploadPanel(); if (!Q.list.some(x => x.state === 'wait' || x.state === 'up')) { toast('Upload finished'); load(); } pump(); };
    if (u.file.size > BIG_FILE) { uploadChunked(u, dir, name, bar, txt, fin); continue; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiUrl(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}&mtime=${u.file.lastModified}`));
    xhr.setRequestHeader('X-Requested-With', 'cloud'); for (const [hk, hv] of Object.entries(authHeaders())) xhr.setRequestHeader(hk, hv);
    xhr.upload.onprogress = e => { if (e.lengthComputable) { u.pct = e.loaded / e.total * 100; bar().style.width = u.pct + '%'; txt().textContent = `${fmtSize(e.loaded)} / ${fmtSize(e.total)}`; } };
    xhr.onload = () => { if (xhr.status === 200) fin(true); else { let m = 'Failed'; try { m = JSON.parse(xhr.responseText).error; } catch { /* ignore */ } fin(false, m); } };
    xhr.onerror = () => fin(false, 'Network error');
    xhr.send(u.file);
  }
}

// ---------- viewer (every file type) ----------
const DIRECT_VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
const DIRECT_AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']);
function viewer(list, idx) {
  let i = idx;
  const stage = h('div', { class: 'stage' }), title = h('div', { class: 't' });
  const meta = h('div', { class: 'vmeta' });
  const dlBtn = h('button', { onclick: () => download(fileUrl(pathOf(list[i]), true)) }, '⬇ Download');
  let curImg = null;
  const origBtn = h('button', { hidden: true, onclick: () => { if (curImg) { curImg.src = fileUrl(pathOf(list[i])); origBtn.hidden = true; } } }, '🔍 Original quality');
  const v = h('div', { class: 'viewer', tabIndex: 0 }, h('div', { class: 'top' }, title, origBtn, dlBtn, h('button', { onclick: close }, '✕ Close')), stage, meta);
  function close() { v.remove(); document.removeEventListener('keydown', key); }
  const card = (it, msg) => h('div', { class: 'vcard' }, h('div', { style: 'font-size:80px' }, ICON[it.kind] || '📄'), h('h3', {}, it.name), h('p', {}, msg || 'This file type can\'t be previewed in the browser.'), h('p', { class: 'muted' }, `${fmtSize(it.size)} · .${extOf(it.name) || 'file'}`), h('button', { class: 'btn primary', onclick: () => download(fileUrl(pathOf(it), true)) }, '⬇ Download'));
  async function show() {
    const it = list[i], p = pathOf(it), ext = extOf(it.name);
    title.textContent = `${it.name}  ·  ${fmtSize(it.size)}  ·  ${i + 1}/${list.length}`;
    meta.textContent = `Uploaded by ${it.by || 'unknown'} on ${it.at ? fmtDT(it.at) : '—'}  ·  File date ${fmtDT(it.mtime)}  ·  Disk ${it.disk || ''}`;
    stage.replaceChildren();
    const nav2 = () => { if (list.length > 1) stage.append(h('button', { class: 'nav-a prev', onclick: () => step(-1) }, '‹'), h('button', { class: 'nav-a next', onclick: () => step(1) }, '›')); };
    origBtn.hidden = true; curImg = null;
    if (it.kind === 'image') {
      // large photos open as a screen-sized copy first (a few hundred KB instead of several MB); "Original quality" loads the full file
      const big = it.size > 1.5e6 && /^(jpe?g|png|webp|bmp|avif|jfif)$/.test(ext);
      const pw = innerWidth * (devicePixelRatio || 1) > 1500 ? 1920 : 1280;
      const img = h('img', { alt: it.name, onerror: e => { if (big && e.target.src.includes('/api/preview')) { e.target.src = fileUrl(p); origBtn.hidden = true; } else e.target.replaceWith(h('img', { src: mediaUrl('/api/preview?path=' + encodeURIComponent(p)), alt: it.name, onerror: ev => ev.target.replaceWith(card(it, 'This image could not be displayed.')) })); } });
      img.src = big ? mediaUrl(`/api/preview?path=${encodeURIComponent(p)}&w=${pw}`) : fileUrl(p);
      curImg = img; origBtn.hidden = !big;
      stage.append(img);
    }
    else if (it.kind === 'imageconv') {
      const note = h('div', { class: 'muted vnote' }, 'Preparing preview… (DSLR/RAW and special formats are converted on the fly the first time)');
      const img = h('img', { alt: it.name, style: 'display:none', onload: e => { e.target.style.display = ''; note.remove(); }, onerror: () => { note.replaceWith(card(it, 'No preview could be created for this format, but the file is stored safely.')); } });
      img.src = mediaUrl('/api/preview?path=' + encodeURIComponent(p));
      stage.append(note, img);
    } else if (it.kind === 'video') {
      const note = h('div', { class: 'vnote' });
      const useTx = () => { note.textContent = 'Converting for playback — seeking is limited in this mode.'; vid.src = mediaUrl('/api/transcode?path=' + encodeURIComponent(p)); vid.play().catch(() => {}); };
      const vid = h('video', { controls: true, autoplay: true, playsInline: true, onerror: () => { if (!vid._tx) { vid._tx = 1; useTx(); } else note.textContent = 'This video could not be played. You can still download it.'; } });
      if (DIRECT_VIDEO.has(ext)) vid.src = fileUrl(p); else { vid._tx = 1; useTx(); }
      stage.append(vid, note);
    } else if (it.kind === 'audio') {
      const note = h('div', { class: 'vnote' });
      const aud = h('audio', { controls: true, autoplay: true, onerror: () => { if (!aud._tx) { aud._tx = 1; note.textContent = 'Converting…'; aud.src = mediaUrl('/api/transcode?path=' + encodeURIComponent(p)); aud.play().catch(() => {}); } } });
      if (DIRECT_AUDIO.has(ext)) aud.src = fileUrl(p); else { aud._tx = 1; aud.src = mediaUrl('/api/transcode?path=' + encodeURIComponent(p)); note.textContent = 'Converting…'; }
      stage.append(h('div', { style: 'text-align:center' }, h('div', { style: 'font-size:90px' }, '🎵'), aud, note));
    } else if (it.kind === 'pdf') stage.append(h('iframe', { src: fileUrl(p) }));
    else if (it.kind === 'archive') archiveView(it, stage);
    else if (it.kind === 'text' && it.size < 2e6) { const pre = h('pre', {}, 'Loading…'); stage.append(pre); fetch(fileUrl(p)).then(r => r.text()).then(t => { pre.textContent = t; }); }
    else if (it.kind === 'office') stage.append(card(it, 'Office documents can\'t be shown here. Download to open in Word / Excel / PowerPoint.'));
    else if (it.size < 2e6 && it.size > 0) {
      // unknown type: if it looks like text, show it; otherwise a download card
      try {
        const r = await fetch(fileUrl(p)); const buf = new Uint8Array(await r.arrayBuffer());
        const head = buf.subarray(0, 4096); let bad = 0; for (const b of head) if (b === 0 || (b < 7) || (b > 13 && b < 32 && b !== 27)) bad++;
        if (bad / Math.max(1, head.length) < 0.02) { stage.append(h('pre', {}, new TextDecoder('utf-8', { fatal: false }).decode(buf))); nav2(); return; }
      } catch { /* fall through */ }
      stage.append(card(it));
    } else stage.append(card(it));
    nav2();
  }
  function step(d) { i = (i + d + list.length) % list.length; show(); }
  function key(e) { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); }
  document.addEventListener('keydown', key);
  document.body.append(v); show();
}
async function archiveView(it, stage) {
  const box = h('div', { class: 'vcard wide' }, h('h3', {}, '🗜️ ' + it.name), h('p', { class: 'muted' }, 'Reading archive…'));
  stage.append(box);
  const load2 = async pw => {
    try {
      const r = await api('GET', '/api/archive?path=' + encodeURIComponent(pathOf(it)) + (pw ? '&pw=' + encodeURIComponent(pw) : ''));
      box.replaceChildren(h('h3', {}, '🗜️ ' + it.name), h('p', { class: 'muted' }, `${r.type} archive · ${r.count} items · ${fmtSize(r.total)} when extracted`),
        h('div', { class: 'tablewrap archlist' }, h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Size'), h('th', {}, 'Modified')), r.entries.map(e => h('tr', {}, h('td', {}, (e.dir ? '📁 ' : '📄 ') + e.path), h('td', { class: 'muted' }, e.dir ? '' : fmtSize(e.size)), h('td', { class: 'muted' }, e.modified || ''))))),
        r.truncated ? h('p', { class: 'muted' }, 'Showing the first 2000 items.') : null,
        h('div', { class: 'row-btns', style: 'justify-content:center;margin-top:10px' }, canEdit() && S.tools.archive ? h('button', { class: 'btn primary', onclick: () => { document.querySelector('.viewer').remove(); extractDialog(it, pw); } }, '📂 Extract…') : null, h('button', { class: 'btn', onclick: () => download(fileUrl(pathOf(it), true)) }, '⬇ Download')));
    } catch (e) {
      const pwd = h('input', { type: 'password', placeholder: 'Archive password' });
      box.replaceChildren(h('h3', {}, '🗜️ ' + it.name), h('p', { class: 'err' }, e.message), /password/i.test(e.message) ? h('div', {}, pwd, h('button', { class: 'btn primary', style: 'margin-left:6px', onclick: () => load2(pwd.value) }, 'Open')) : null, h('p', {}, h('button', { class: 'btn', onclick: () => download(fileUrl(pathOf(it), true)) }, '⬇ Download')));
    }
  };
  load2('');
}

// ---------- account: menu, password, two-step ----------
function userMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  popup([[`Signed in as ${S.user.name} (${S.user.role})`, () => {}], null,
    ...(isStandalone() ? [] : [['📲 Install the Damaniya Cloud app', installApp]]),
    ['Change password', changePassword],
    [S.user.totp ? '🔐 Two-step verification: ON' : '🔐 Turn on two-step verification', twoFactorDialog],
    ['Sign out on all devices', async () => { await api('POST', '/api/logout-all'); S.user = null; location.hash = ''; render(); }],
    ['Sign out', async () => { await api('POST', '/api/logout'); S.user = null; location.hash = ''; render(); }]], Math.max(8, r.right - 250), r.bottom + 4);
}
function changePassword() {
  const o = h('input', { type: 'password', placeholder: 'Current password' }), n = h('input', { type: 'password', placeholder: 'New password (10+ characters)' });
  modal('Change password', h('div', { style: 'display:grid;gap:8px' }, o, n, h('p', { class: 'muted' }, 'You will stay signed in here; all other devices are signed out.')), [{ text: 'Cancel' }, { text: 'Change', cls: 'primary', run: async () => { try { await api('POST', '/api/password', { old: o.value, new: n.value }); toast('Password changed'); } catch (x) { toast(x.message); return false; } } }]);
}
async function twoFactorDialog() {
  if (S.user.totp) {
    const pw = h('input', { type: 'password', placeholder: 'Your password' }), code = h('input', { type: 'text', inputMode: 'numeric', placeholder: '6-digit code' });
    return modal('Turn off two-step verification?', h('div', { style: 'display:grid;gap:8px' }, h('p', {}, 'Your account will be protected by the password only.'), pw, code), [{ text: 'Keep it on' }, { text: 'Turn off', cls: 'danger', run: async () => { try { await api('POST', '/api/2fa/disable', { password: pw.value, code: code.value }); S.user.totp = false; toast('Two-step verification is off'); render(); } catch (x) { toast(x.message); return false; } } }]);
  }
  try {
    const b = await api('POST', '/api/2fa/begin');
    const code = h('input', { type: 'text', inputMode: 'numeric', placeholder: '6-digit code from the app', maxLength: 7 });
    modal('Turn on two-step verification', h('div', { style: 'display:grid;gap:8px;justify-items:center' },
      h('p', {}, '1. Install an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).'), h('p', {}, '2. Scan this code (or type the key by hand):'),
      b.qr ? h('img', { class: 'qr', alt: 'QR code', src: 'data:image/svg+xml;base64,' + btoa(b.qr) }) : null, h('code', { class: 'secret' }, b.secret),
      h('p', {}, '3. Enter the 6-digit code it shows:'), code),
    [{ text: 'Cancel' }, { text: 'Turn on', cls: 'primary', run: async () => { try { await api('POST', '/api/2fa/enable', { code: code.value }); S.user.totp = true; toast('Two-step verification is ON'); render(); } catch (x) { toast(x.message); return false; } } }]);
  } catch (x) { toast(x.message); }
}

// ---------- people ----------
async function renderUsers(main) {
  main.append(h('div', { class: 'toolbar' }, h('div', { class: 'crumbs' }, h('button', {}, 'People')), h('div', { style: 'flex:1' }), h('button', { class: 'btn primary small', onclick: addUser }, '＋ Add person')));
  main.append(h('div', { class: 'banner info' }, h('b', {}, 'Roles: '), 'Admin = everything incl. disks & permanent delete · Editor = view, upload, rename, move, delete to trash · Viewer = view and download only.'));
  const { users } = await api('GET', '/api/users');
  main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Two-step'), h('th', {})),
    users.map(u => h('tr', {}, h('td', {}, u.name), h('td', {}, u.role), h('td', {}, u.totp ? '🔐 On' : h('span', { class: 'muted' }, 'Off'), u.totp && u.name !== S.user.name ? h('button', { class: 'btn small', style: 'margin-left:8px', onclick: async () => { if (await confirmBox('Reset two-step for ' + u.name + '?', 'They will sign in with the password only until they turn it on again (use this if they lost their phone).', 'Reset', true)) { await api('POST', '/api/users/reset2fa', { username: u.name }); render(); } } }, 'Reset') : null),
      h('td', {}, u.name === S.user.name ? h('span', { class: 'muted' }, 'you') : h('button', { class: 'btn danger small', onclick: async () => { if (await confirmBox('Remove ' + u.name + '?', 'They will no longer be able to sign in.', 'Remove', true)) { await api('DELETE', '/api/users', { username: u.name }); render(); } } }, 'Remove')))))));
}
function addUser() {
  const u = h('input', { type: 'text', placeholder: 'Username' }), p = h('input', { type: 'password', placeholder: 'Password (10+ characters)' });
  const r = h('select', {}, h('option', { value: 'viewer' }, 'Viewer (look & download)'), h('option', { value: 'editor' }, 'Editor (upload & delete to trash)'), h('option', { value: 'admin' }, 'Admin (everything)'));
  modal('Add person', h('div', { style: 'display:grid;gap:8px' }, u, p, r), [{ text: 'Cancel' }, { text: 'Save', cls: 'primary', run: async () => { try { await api('POST', '/api/users', { username: u.value.trim(), password: p.value, role: r.value }); render(); } catch (x) { toast(x.message); return false; } } }]);
}

// ---------- activity log ----------
async function renderActivity(main) {
  main.append(h('div', { class: 'toolbar' }, h('div', { class: 'crumbs' }, h('button', {}, 'Activity Log')), h('span', { class: 'muted' }, 'Every sign-in, upload, download, delete and admin action. Newest first.')));
  const { items } = await api('GET', '/api/audit?limit=500');
  const detail = d => d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
  main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Details'), h('th', {}, 'From')),
    items.map(a => h('tr', { class: /fail|locked/.test(a.ev) ? 'warnrow' : '' }, h('td', {}, fmtDT(a.t)), h('td', {}, a.who), h('td', {}, a.ev), h('td', { class: 'muted wrap' }, detail(a.d)), h('td', { class: 'muted' }, a.ip))))));
}

// ---------- storage & health ----------
let storageTimer = null, storageGen = 0, storageDraw = null;
async function renderStorage(host) {
  const gen = ++storageGen; clearInterval(storageTimer);
  const stamp = h('span', { class: 'muted', style: 'font-size:12px' }, 'Checking disks…');
  const box = h('div');
  let busy = false;
  const draw = async force => {
    if (busy) return; busy = true;
    try {
      const rep = await api('GET', '/api/disks' + (force ? '?refresh=1' : ''));
      try { const s = await api('GET', '/api/session'); S.publicUrl = s.publicUrl; S.fixedUrl = s.fixedUrl; } catch { /* ignore */ }
      if (gen !== storageGen || !host.isConnected) { clearInterval(storageTimer); return; }
      box.replaceChildren(buildStorage(rep));
      stamp.textContent = '● Live · last check ' + new Date(rep.at).toLocaleTimeString() + ' · auto-updates every 15 s';
    } catch (e) { if (gen === storageGen) box.replaceChildren(h('div', { class: 'banner' }, e.message)); } finally { busy = false; }
  };
  storageDraw = draw;
  host.append(h('div', { class: 'toolbar' }, h('div', { class: 'crumbs' }, h('button', {}, 'Storage & Health')), h('div', { style: 'flex:1' }), stamp, h('button', { class: 'btn small', onclick: () => draw(true) }, '↻ Check now')), box);
  await draw(true);
  storageTimer = setInterval(() => draw(false), 15000);
}
function buildStorage(rep) {
  const main = document.createDocumentFragment();
  main.append(h('div', { class: 'banner info' }, h('b', {}, 'Fast internet address (changes after a restart): '), S.publicUrl && S.publicUrl !== S.fixedUrl ? h('a', { href: S.publicUrl, target: '_blank', rel: 'noopener' }, S.publicUrl) : 'not active',
    S.fixedUrl ? h('div', {}, h('b', {}, 'Fixed backup address (slower): '), h('a', { href: S.fixedUrl, target: '_blank', rel: 'noopener' }, S.fixedUrl)) : null,
    h('div', { class: 'muted' }, 'Home network: http://' + location.host)));
  if (!rep.isAdmin) main.append(h('div', { class: 'banner info' }, '⚠ The server is not running as Administrator: format/clone buttons and detailed health are limited.'));
  if (rep.error) main.append(h('div', { class: 'banner' }, 'Could not read disks: ' + rep.error));
  const pool = rep.disks.filter(d => d.role === 'pool');
  for (const d of rep.disks.filter(d => d.role === 'retired')) {
    const nl = d.formerId ? `Its sticker still says ${d.formerId}: change it to ${d.cloudId}. ` : '';
    main.append(h('div', { class: 'banner' }, `🔧 Disk ${d.cloudId} (serial ${d.serial || '?'}) is retired${d.replacedBy ? ' and replaced by ' + d.replacedBy : ''}. You can remove it from the PC now. ${nl}`));
  }
  const missing = (S.alerts || []).filter(a => a.missing);
  for (const a of missing) main.append(h('div', { class: 'banner' }, `⚠ ${a.id} is not detected by Windows. Check its cables / power.`));
  const unassigned = rep.disks.filter(d => d.role === 'unassigned');
  for (const d of unassigned) {
    if (d.blank && rep.settings.autoAdopt) main.append(h('div', { class: 'banner info' }, `🆕 New blank disk detected (${d.model}). ${d.adoptIn ? `It will be formatted and added automatically in ${d.adoptIn} s.` : 'Setting it up now…'}`));
    else if (d.blank) main.append(h('div', { class: 'banner info' }, `🆕 New blank disk detected (${d.model}). Automatic setup is OFF: press "Add as new storage" below.`));
    else main.append(h('div', { class: 'banner info' }, `🆕 Disk "${d.model}" contains existing data, so it was NOT formatted automatically. Press a button on its card below only if you want to erase it.`));
  }
  const mk = (title, ds) => { if (!ds.length) return; main.append(h('h3', { class: 'sec' }, title), h('div', { class: 'dgrid' }, ds.map(d => diskCard(d, rep)))); };
  mk('In your cloud', pool);
  mk('New / unassigned disks (not used by the cloud yet)', unassigned);
  mk('Retired disks still plugged in', rep.disks.filter(d => d.role === 'retired'));
  mk('Windows disk (never touched)', rep.disks.filter(d => d.role === 'system'));
  const auto = h('input', { type: 'checkbox', checked: rep.settings.autoAdopt, onchange: async e => { await api('POST', '/api/settings', { autoAdopt: e.target.checked }); storageDraw(true); } });
  main.append(h('div', { class: 'banner info', style: 'margin-top:20px' }, h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:600' }, auto, 'Automatically set up new blank disks about 1 minute after they are plugged in'),
    h('div', { class: 'muted', style: 'font-weight:400;margin-top:4px' }, 'Only brand-new/unformatted internal disks are set up automatically. A disk that already has data is never erased without you pressing a button and typing a confirmation.')));
  main.append(h('div', { class: 'banner info' }, h('b', {}, 'Replacing a bad disk: '), '1) Plug the new disk in. 2) Press "Clone to new disk" on the bad one. 3) The new disk takes over the ID (e.g. HDD-01) and the old disk gets a new retired ID. 4) Put the new stickers as shown in the green box and remove the old disk.'));
  main.append(h('div', { class: 'banner info' }, h('b', {}, 'Server: '), h('button', { class: 'btn small', onclick: async () => { if (await confirmBox('Restart the server?', 'Damaniya Cloud will be unavailable for about a minute while it restarts itself.', 'Restart', true)) { try { await api('POST', '/api/admin/restart'); toast('Restarting… back in about a minute.'); } catch (e) { toast(e.message); } } } }, '↻ Restart server')));
  return main;
}
function diskCard(d, rep) {
  const lvl = d.role === 'system' ? 'grey' : d.grade.level;
  const used = d.volumeTotal ? d.volumeTotal - d.volumeFree : 0, pct = d.volumeTotal ? used / d.volumeTotal * 100 : 0;
  const kv = [['Model', d.model], ['Serial', d.serial || '—'], ['Type', `${d.mediaType || '?'} · ${d.busType}`], ['Size', fmtSize(d.size)], ['Windows disk #', d.number], ['Drive letter', d.letters.length ? d.letters.map(l => l + ':').join(', ') : '—']];
  if (d.temp != null) kv.push(['Temperature', `${d.temp} °C` + (d.tempAttr ? ` (drive sensor, SMART #${d.tempAttr})` : '')]);
  if (d.powerOnHours != null) kv.push(['Powered on', `${Math.round(d.powerOnHours / 24)} days (${d.powerOnHours} h)`]);
  if (d.smartPassed != null) kv.push(['SMART test', d.smartPassed ? 'Passed ✓' : 'FAILED ✖']);
  if (d.reallocated != null) kv.push(['Bad sectors', `${d.reallocated} reallocated · ${d.pending || 0} pending`]);
  if (d.readErrors != null) kv.push(['Read errors', d.readErrors]);
  if (d.wear != null) kv.push(['Wear', d.wear + '%']);
  const card = h('div', { class: 'disk ' + (lvl === 'bad' ? 'bad' : lvl === 'warn' ? 'warn' : '') },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, h('span', { class: 'idtag' + (d.cloudId ? '' : ' none') }, d.cloudId || (d.role === 'system' ? 'SYSTEM' : 'NEW')),
      h('span', { class: 'pill ' + lvl }, d.role === 'system' ? 'Windows' : d.grade.level === 'good' ? '● Healthy' : d.grade.level === 'warn' ? '▲ Warning' : '✖ Bad health')),
    d.volumeTotal ? h('div', {}, h('div', { class: 'bar ' + (pct > 90 ? 'bad' : pct > 75 ? 'warn' : '') }, h('i', { style: 'width:' + pct + '%' })), h('div', { class: 'muted' }, `${fmtSize(used)} used of ${fmtSize(d.volumeTotal)}`)) : null,
    h('div', { class: 'kv' }, kv.map(([k, v]) => [h('b', {}, k), h('span', {}, String(v))])),
    d.grade.reasons.length ? h('div', { class: 'muted' }, d.grade.reasons.join(' · ')) : null);
  const acts = h('div', { class: 'row-btns', style: 'justify-content:flex-start' });
  if (d.role === 'unassigned') {
    acts.append(h('button', { class: 'btn small primary', onclick: () => diskAction(d, 'new', null, rep) }, '➕ Add as new storage'));
    for (const s of rep.disks.filter(x => x.role === 'pool')) acts.append(h('button', { class: 'btn small', onclick: () => diskAction(d, 'clone', s, rep) }, `📋 Clone ${s.cloudId} to this disk`));
  } else if (d.role === 'pool') {
    acts.append(h('button', { class: 'btn small' + (d.grade.level !== 'good' ? ' danger' : ''), onclick: () => cloneHelp(d, rep) }, '🔁 Clone to new disk'));
    acts.append(h('button', { class: 'btn small', onclick: () => retire(d) }, 'Retire'));
  }
  card.append(acts);
  return card;
}
function cloneHelp(d, rep) {
  const free = rep.disks.filter(x => x.role === 'unassigned');
  if (!free.length) return modal('Plug in the new hard disk first', h('p', {}, `Insert the replacement hard disk into the PC, wait about 10 seconds, then press ↻ Check now. It will appear under "New / unassigned disks" with a button to clone ${d.cloudId} onto it.`), [{ text: 'OK', cls: 'primary' }]);
  const sel = h('select', {}, free.map(f => h('option', { value: f.number }, `Disk #${f.number} · ${f.model} · ${fmtSize(f.size)} · serial ${f.serial}`)));
  modal(`Clone ${d.cloudId} to a new disk`, h('div', { style: 'display:grid;gap:8px' }, h('p', {}, 'Choose the NEW disk. It will be completely erased.'), sel), [{ text: 'Cancel' }, { text: 'Next', cls: 'primary', run: () => { const t = free.find(f => f.number === +sel.value); setTimeout(() => diskAction(t, 'clone', d, rep), 0); } }]);
}
function diskAction(target, mode, source, rep) {
  const phrase = 'FORMAT ' + target.number;
  const inp = h('input', { type: 'text', placeholder: phrase });
  const swap = h('input', { type: 'checkbox', checked: true });
  const words = mode === 'clone' ? `Disk #${target.number} (${target.model}, serial ${target.serial}) will be ERASED and become a copy of ${source.cloudId}.` : `Disk #${target.number} (${target.model}, serial ${target.serial}) will be ERASED and added to your cloud as new storage.`;
  modal(mode === 'clone' ? 'Clone to new disk' : 'Add new storage', h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'banner' }, words),
    mode === 'clone' ? h('label', { style: 'display:flex;gap:8px;align-items:flex-start' }, swap, h('span', {}, `New disk takes over the ID ${source.cloudId}; the old disk becomes a new retired ID (recommended)`)) : null,
    h('p', {}, 'Everything currently on the target disk will be permanently deleted. To confirm, type: ', h('b', {}, phrase)), inp),
    [{ text: 'Cancel' }, { text: 'Erase & start', cls: 'danger', run: async () => { try { const r = await api('POST', '/api/disks/start', { diskNumber: target.number, mode, sourceId: source && source.cloudId, swap: swap.checked, confirm: inp.value.trim() }); watchJob(r.jobId); } catch (x) { toast(x.message); return false; } } }]);
}
function watchJob(id) {
  const step = h('div', {}, 'Starting…'), bar = h('i', { style: 'width:0' }), log = h('pre', { class: 'muted', style: 'max-height:140px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0' }), result = h('div');
  modal('Working on the disk — please don\'t unplug anything', h('div', { style: 'display:grid;gap:8px' }, step, h('div', { class: 'bar' }, bar), log, result), [{ text: 'Hide' }]);
  const t = setInterval(async () => {
    try {
      const j = await api('GET', '/api/disks/job?id=' + id);
      step.textContent = j.step + (j.state === 'running' ? ` — ${j.percent}%` : ''); bar.style.width = j.percent + '%'; log.textContent = j.log.join('\n');
      if (j.state !== 'running') {
        clearInterval(t);
        if (j.state === 'done') result.append(h('div', { class: 'banner good' }, `✅ New disk is now ${j.newId}. Put the sticker "${j.newId}" on it.`, j.source ? h('div', {}, j.swap ? `Old disk: relabel its sticker from ${j.source} to ${j.retiredAs} and remove it from the PC.` : `Old disk ${j.source} is retired — remove it from the PC.`) : null));
        else toast('Disk job failed');
        if (storageDraw) storageDraw(true); refreshStats();
      }
    } catch { /* retry */ }
  }, 2000);
}
function retire(d) {
  const inp = h('input', { type: 'text', placeholder: 'RETIRE ' + d.cloudId });
  modal('Retire ' + d.cloudId, h('div', { style: 'display:grid;gap:8px' }, h('p', {}, `${d.cloudId} will stop being part of the cloud and its files will no longer show on the website. Nothing is erased on the disk. Only do this if the data is already cloned elsewhere.`), h('p', {}, 'Type ', h('b', {}, 'RETIRE ' + d.cloudId), ' to confirm.'), inp),
    [{ text: 'Cancel' }, { text: 'Retire', cls: 'danger', run: async () => { try { await api('POST', '/api/disks/retire', { id: d.cloudId, confirm: inp.value.trim() }); if (storageDraw) storageDraw(true); } catch (x) { toast(x.message); return false; } } }]);
}

// ---------- disk history ----------
const EV = { added: '➕ Added', cloned: '📋 Cloned', swapped: '🔁 Swapped', retired: '📦 Retired', detected: '🆕 Detected', failed: '✖ Failed' };
async function renderHistory(main) {
  main.append(h('div', { class: 'toolbar' }, h('div', { class: 'crumbs' }, h('button', {}, 'Disk History')), h('span', { class: 'muted' }, 'Every disk ever used, and everything that happened to it.')));
  const { history, register } = await api('GET', '/api/disks/history');
  main.append(h('h3', { class: 'sec' }, 'All disks (register)'));
  const st = { active: '● In use', retired: '📦 Retired' };
  main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('tr', {}, ['ID', 'Status', 'Model', 'Serial', 'Size', 'Added', 'Retired', 'Replaced by / was', 'Health when retired', 'Last seen'].map(x => h('th', {}, x))),
    register.sort((a, b) => a.id.localeCompare(b.id)).map(r => h('tr', {}, h('td', {}, h('span', { class: 'idtag small' }, r.id)), h('td', {}, st[r.status] || r.status), h('td', {}, r.model || '—'), h('td', {}, r.serial || '—'), h('td', {}, r.size ? fmtSize(r.size) : '—'), h('td', { class: 'muted' }, fmtDT(r.addedAt)), h('td', { class: 'muted' }, r.retiredAt ? fmtDT(r.retiredAt) : '—'),
      h('td', {}, r.replacedBy ? 'replaced by ' + r.replacedBy : r.clonedFrom ? 'cloned from ' + r.clonedFrom : '—', r.formerId ? ` (sticker was ${r.formerId})` : ''), h('td', {}, r.healthAtRetire ? (r.healthAtRetire.level + (r.healthAtRetire.reasons.length ? ': ' + r.healthAtRetire.reasons.join(', ') : '')) : '—'), h('td', { class: 'muted' }, r.lastSeen ? fmtDT(r.lastSeen) : '—'))))));
  main.append(h('h3', { class: 'sec' }, 'Timeline'));
  main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' }, h('tr', {}, ['When', 'Event', 'Disk', 'Model', 'Serial', 'By', 'Details'].map(x => h('th', {}, x))),
    history.map(e => h('tr', {}, h('td', {}, fmtDT(e.t)), h('td', {}, EV[e.type] || e.type), h('td', {}, e.diskId || ''), h('td', {}, e.model || e.newModel || ''), h('td', {}, e.serial || e.newSerial || ''), h('td', { class: 'muted' }, e.who || ''), h('td', { class: 'muted wrap' }, e.note || ''))))));
}

// ---------- installable app (PWA) ----------
let installEvent = null;
const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Damaniya Cloud is installed. Open it from your home screen.'); });
// The free internet addresses (*.trycloudflare.com) change after every restart: an app installed from one would stop working.
// So on those addresses the app never offers to install; it points to the permanent install page instead.
const LAUNCHER = 'https://abbuthegreat.github.io/damaniya-cloud/';
const PHOTOS_URL = 'https://abbuthegreat.github.io/damaniya-photos/';
const onTemporaryAddress = () => /\.trycloudflare\.com$/i.test(location.hostname);
if (onTemporaryAddress()) document.querySelectorAll('link[rel=manifest]').forEach(l => l.remove());
function installApp() {
  if (onTemporaryAddress()) {
    return modal('Install from the permanent link', h('div', { style: 'display:grid;gap:8px' },
      h('p', {}, 'You are on a temporary internet address. An app installed from here would stop working the next time the address changes.'),
      h('p', {}, 'Open the permanent install page instead: it installs an icon that always finds your cloud.')),
    [{ text: 'Cancel' }, { text: 'Open install page', cls: 'primary', run: () => { location.href = (PHOTOS ? PHOTOS_URL : LAUNCHER) + '#install'; } }]);
  }
  if (installEvent) { installEvent.prompt(); installEvent.userChoice.finally(() => { installEvent = null; }); return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  modal('Install ' + APPNAME, h('div', { style: 'display:grid;gap:8px' },
    ios ? [h('p', {}, 'On iPhone / iPad (use Safari):'), h('p', {}, '1. Tap the Share button (the square with an arrow).'), h('p', {}, '2. Choose "Add to Home Screen".'), h('p', {}, '3. Tap Add. The app now opens from your home screen.')]
      : [h('p', {}, 'On Android (use Chrome):'), h('p', {}, '1. Tap the ⋮ menu at the top right.'), h('p', {}, '2. Choose "Install app" (or "Add to Home screen").'), h('p', {}, '3. Confirm. The app now opens from your home screen.'),
         h('p', { class: 'muted' }, 'On a computer: click the install icon at the right of the address bar.'),
         location.protocol === 'https:' || location.hostname === 'localhost' ? null : h('p', { class: 'err' }, 'Installing needs the secure (https) internet address, not the home Wi-Fi address.')]),
    [{ text: 'OK', cls: 'primary' }]);
}
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

// ================= phone layout (bottom tabs, bottom sheets, big touch targets) =================
// Only used on narrow screens (phones). The desktop layout above is untouched.
const mq = matchMedia('(max-width: 760px)');
const isMobile = () => mq.matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SVG = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 13h6m0 0-2-2m2 2-2 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  restore: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
};
function svg(name) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = SVG[name]; return s; }
const stripEmoji = s => s.replace(/^[\p{Extended_Pictographic}️‍]+\s*/u, '');
function iconFor(label) {
  const m = /^([\p{Extended_Pictographic}️‍]+)/u.exec(label); if (m) return m[1];
  const l = label.toLowerCase();
  return /open/.test(l) ? '📂' : /zip|compress/.test(l) ? '🗜️' : /extract/.test(l) ? '📦' : /download/.test(l) ? '⬇️' : /rename/.test(l) ? '✏️' : /move/.test(l) ? '📁' : /delete/.test(l) ? '🗑️' : /restore/.test(l) ? '♻️' : /folder/.test(l) ? '📍' : '•';
}
let noClickUntil = 0;

// ---- bottom sheets ----
function closeSheet(cancelled) {
  const had = document.querySelector('.m-sheet-bg');
  document.querySelectorAll('.m-sheet-bg').forEach(b => b.remove());
  if (had && cancelled && sheetOnCancel) { const f = sheetOnCancel; sheetOnCancel = null; f(); }
  if (!cancelled) sheetOnCancel = null;
}
let sheetOnCancel = null;
function sheet(title, rows, onCancel) {
  closeSheet(false); sheetOnCancel = onCancel || null;
  const bg = h('div', { class: 'm-sheet-bg', onclick: e => { if (e.target === bg) closeSheet(true); } });
  const panel = h('div', { class: 'm-sheet', role: 'dialog' }, h('div', { class: 'grab' }), title ? h('h4', {}, title) : null,
    rows.map(r => !r ? h('hr') : h('button', { class: 'm-srow' + (r.danger ? ' danger' : ''), onclick: () => { closeSheet(false); setTimeout(() => r.on && r.on(), 10); } },
      h('span', { class: 'ic' }, r.icon || '•'), h('span', { class: 'lb' }, r.label), r.sub ? h('small', { class: 'muted' }, r.sub) : null)));
  bg.append(panel); document.body.append(bg);
  let y0 = null;
  panel.addEventListener('touchstart', e => { if (panel.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  panel.addEventListener('touchmove', e => { if (y0 != null) { const dy = e.touches[0].clientY - y0; if (dy > 0) panel.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  panel.addEventListener('touchend', e => { if (y0 != null) { const dy = e.changedTouches[0].clientY - y0; y0 = null; if (dy > 90) closeSheet(true); else panel.style.transform = ''; } });
}

// ---- existing pop-up menus become bottom sheets on phones ----
const _popup = popup, _ctxMenu = ctxMenu, _moreBtn = moreBtn, _viewer = viewer, _moveSel = moveSel, _render = render;
let nextSheetTitle = null, nextSheetCancel = null;
popup = function (items, x, y) {
  if (!isMobile()) return _popup(items, x, y);
  const title = nextSheetTitle, cancel = nextSheetCancel; nextSheetTitle = null; nextSheetCancel = null;
  sheet(title, items.map(i => i ? { icon: iconFor(i[0]), label: stripEmoji(i[0]), on: i[1], danger: /delete/i.test(i[0]) } : null), cancel);
};
ctxMenu = function (e, it) { if (isMobile()) nextSheetTitle = it.name; return _ctxMenu(e, it); };
moreBtn = function (it) {
  if (!isMobile()) return _moreBtn(it);
  return h('button', { class: 'm-more', 'aria-label': 'More actions', onclick: e => { e.stopPropagation(); S.sel = new Set([pathOf(it)]); nextSheetCancel = () => S.sel.clear(); ctxMenu({ clientX: 0, clientY: 0 }, it); } }, svg('more'));
};
// move: pick the destination folder from a list instead of typing a path
function mPickFolder(startPath) {
  return new Promise(resolve => {
    const show = async path => {
      let items = []; try { items = (await api('GET', '/api/list?path=' + encodeURIComponent(path))).items.filter(isFolder); } catch (e) { toast(e.message); }
      const here = path ? path.split('/').pop() : 'My Drive';
      const rows = [{ icon: '✅', label: `Move here  (${here})`, on: () => resolve(path) }];
      if (path) rows.push({ icon: '⬆️', label: 'Up one level', on: () => show(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') });
      rows.push(null);
      if (!items.length) rows.push({ icon: '📭', label: 'No folders in here' });
      for (const f of items) rows.push({ icon: '📁', label: f.name, on: () => show(join(path, f.name)) });
      sheet('Move to…', rows, () => resolve(null));
    };
    show(startPath || '');
  });
}
moveSel = async function () {
  if (!isMobile()) return _moveSel();
  const dest = await mPickFolder(S.path); if (dest == null) return;
  try { await api('POST', '/api/move', { paths: [...S.sel], dest }); S.sel.clear(); toast('Moved'); load(); } catch (e) { toast(e.message); }
};
function pickAccept(accept, capture) {
  const inp = h('input', { type: 'file', multiple: !capture, accept, style: 'position:fixed;left:-9999px;opacity:0' }); if (capture) inp.setAttribute('capture', capture);
  document.body.append(inp);
  inp.onchange = () => { uploadFiles([...inp.files].map(f => ({ file: f, rel: f.name }))); setTimeout(() => inp.remove(), 60000); };
  inp.addEventListener('cancel', () => inp.remove());
  inp.click();
}
function mNewSheet() {
  const dir = S.view === 'drive' ? S.path : '';
  const rows = [
    { icon: '📁', label: 'New folder', on: async () => { const n = await ask('New folder', '', 'Untitled folder', 'Create'); if (n) { try { await api('POST', '/api/mkdir', { path: join(dir, n) }); load(); } catch (x) { toast(x.message); } } } },
    null,
    { icon: '🖼️', label: 'Upload photos & videos', on: () => pickAccept('image/*,video/*') },
    { icon: '📄', label: 'Upload files', on: () => pickAccept('') },
    { icon: '📷', label: 'Take a photo or video', on: () => pickAccept('image/*,video/*', 'environment') },
  ];
  if (!isIOS) rows.push({ icon: '📤', label: 'Upload a folder', on: () => pick(true) });
  sheet('Add to ' + (S.path ? S.path.split('/').pop() : 'My Drive'), rows);
}
function mMoreSheet() {
  const st = S.stats, used = st ? st.total - st.free : 0;
  const rows = [];
  if (st) rows.push({ icon: '💾', label: `${fmtSize(used)} of ${fmtSize(st.total)} used`, sub: `${st.disks} disk${st.disks === 1 ? '' : 's'}` }, null);
  if (!isStandalone()) rows.push({ icon: '📲', label: 'Install the app', on: installApp });
  rows.push({ icon: '🔑', label: 'Change password', on: changePassword }, { icon: '🔐', label: S.user.totp ? 'Two-step verification: ON' : 'Turn on two-step verification', on: twoFactorDialog });
  if (isAdminUser()) rows.push(null, { icon: '💽', label: 'Storage & Health', on: () => nav('storage') }, { icon: '🗂️', label: 'Disk History', on: () => nav('history') }, { icon: '🕵️', label: 'Activity Log', on: () => nav('activity') }, { icon: '👥', label: 'People', on: () => nav('users') });
  rows.push(null, { icon: '📵', label: 'Sign out on all devices', on: async () => { await api('POST', '/api/logout-all'); S.user = null; location.hash = ''; render(); } }, { icon: '🚪', label: 'Sign out', danger: true, on: async () => { await api('POST', '/api/logout'); S.user = null; location.hash = ''; render(); } });
  sheet(`${S.user.name} · ${S.user.role}`, rows);
}

// ---- selection by long-press ----
function keyOf(it) { return S.view === 'trash' ? it.id : pathOf(it); }
function press(el, it) {
  let timer = null;
  el.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = null; noClickUntil = Date.now() + 600; if (navigator.vibrate) navigator.vibrate(12); if (!S.sel.has(keyOf(it))) S.sel.add(keyOf(it)); render(); }, 430); }, { passive: true });
  for (const ev of ['touchmove', 'touchend', 'touchcancel']) el.addEventListener(ev, () => { clearTimeout(timer); timer = null; }, { passive: true });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => {
    if (Date.now() < noClickUntil) return;
    if (S.sel.size || S.view === 'trash') toggleSel(keyOf(it)); else open(it);
  });
}

// ---- building blocks ----
function glyph(it) { const f = isFolder(it); return h('span', { class: 'm-glyph' }, f ? '📁' : (ICON[it.kind] || '📄'), f ? null : h('small', {}, (extOf(it.name) || 'file').slice(0, 4).toUpperCase())); }
function mThumb(it) {
  const box = h('div', { class: 'm-th k-' + (isFolder(it) ? 'folder' : it.kind) });
  if (!isFolder(it) && ['image', 'imageconv', 'video'].includes(it.kind) && S.view !== 'trash') {
    box.append(h('img', { loading: 'lazy', decoding: 'async', alt: '', src: mediaUrl('/api/thumb?path=' + encodeURIComponent(pathOf(it))), onerror: e => { e.target.remove(); box.prepend(glyph(it)); } }));
  } else box.append(glyph(it));
  if (it.kind === 'video') box.append(h('span', { class: 'm-play' }, svg('play')));
  return box;
}
const chk = on => h('span', { class: 'm-chk' + (on ? ' on' : '') }, svg('check'));
function subText(it) {
  const trash = S.view === 'trash', by = trash ? it.uploadedBy : it.by, at = trash ? it.uploadedAt : it.at;
  return [isFolder(it) ? '' : fmtSize(it.size), by || '', fmtDate(trash ? it.deletedAt : (at || it.mtime))].filter(Boolean).join(' · ');
}
function mTile(it) {   // square photo-style tile
  const on = S.sel.has(keyOf(it));
  const el = h('div', { class: 'm-tile' + (on ? ' sel' : '') + (S.sel.size ? ' selecting' : ''), role: 'button' }, mThumb(it), h('div', { class: 'm-cap' }, it.name), chk(on));
  press(el, it); return el;
}
function mFolderChip(it) {
  const on = S.sel.has(keyOf(it));
  const el = h('div', { class: 'm-fold' + (on ? ' sel' : ''), role: 'button' }, h('span', { class: 'fi' }, '📁'), h('span', { class: 'nm' }, it.name), S.sel.size ? chk(on) : (S.view === 'trash' ? null : moreBtn(it)));
  press(el, it); return el;
}
function mRow(it) {
  const on = S.sel.has(keyOf(it));
  const el = h('div', { class: 'm-row' + (on ? ' sel' : ''), role: 'button' }, mThumb(it), h('div', { class: 'mid' }, h('div', { class: 'nm' }, it.name), h('div', { class: 'sub' }, subText(it))), S.sel.size ? chk(on) : (S.view === 'trash' ? null : moreBtn(it)));
  press(el, it); return el;
}

// ---- top bar, tabs, selection bar ----
const ib = (name, label, on, cls) => h('button', { class: 'm-ib ' + (cls || ''), 'aria-label': label, onclick: on }, svg(name));
function mTopBar(selecting) {
  const bar = h('header', { class: 'm-top' });
  if (selecting) {
    bar.append(ib('close', 'Cancel selection', () => { S.sel.clear(); render(); }), h('div', { class: 't' }, `${S.sel.size} selected`),
      h('button', { class: 'm-txt', onclick: () => { for (const i of S.items) S.sel.add(keyOf(i)); render(); } }, 'Select all'));
    bar.classList.add('sel'); return bar;
  }
  const root = S.view === 'drive' && !S.path;
  const back = ['storage', 'users', 'history', 'activity'].includes(S.view) || (S.view === 'drive' && S.path);
  const titles = { trash: 'Trash', search: 'Search', storage: 'Storage & Health', users: 'People', history: 'Disk History', activity: 'Activity Log' };
  if (back) bar.append(ib('back', 'Back', () => { if (S.view === 'drive') nav('drive', S.path.includes('/') ? S.path.slice(0, S.path.lastIndexOf('/')) : ''); else nav('drive', ''); }));
  else if (root) bar.append(h('img', { class: 'm-logo', src: 'favicon.svg', alt: '' }));
  bar.append(h('div', { class: 't' + (back ? '' : ' big') }, S.view === 'drive' ? (S.path ? S.path.split('/').pop() : 'Damaniya Cloud') : (titles[S.view] || '')));
  if (S.view === 'drive' || S.view === 'search') bar.append(ib(S.mode === 'grid' ? 'list' : 'grid', 'Switch view', () => { S.mode = S.mode === 'grid' ? 'list' : 'grid'; try { localStorage.setItem('cd_mode', S.mode); } catch { /* ignore */ } render(); }));
  if (S.view === 'trash' && isAdminUser() && S.items.length) bar.append(h('button', { class: 'm-txt danger', onclick: async () => { if (await confirmBox('Empty trash?', 'Everything in the trash will be permanently deleted. This cannot be undone.', 'Delete forever', true)) { await api('POST', '/api/trash/purge', { all: true }); toast('Trash emptied'); load(); } } }, 'Empty'));
  if (root) bar.append(h('button', { class: 'm-avatar', 'aria-label': 'Account', onclick: mMoreSheet }, (S.user.name[0] || '?').toUpperCase()));
  return bar;
}
function mTabs() {
  const t = (id, icon, label, on) => h('button', { class: 'm-tab' + (on ? ' on' : ''), onclick: () => { closeSheet(false); S.sel.clear(); if (id === 'drive') nav('drive', ''); else if (id === 'trash') nav('trash'); else if (id === 'search') { S.view = 'search'; S.items = []; render(); } else mMoreSheet(); } },
    h('span', { class: 'pill' }, svg(icon)), h('span', { class: 'lb' }, label));
  const more = ['storage', 'users', 'history', 'activity'].includes(S.view);
  return h('nav', { class: 'm-tabs' }, t('drive', 'folder', 'Files', S.view === 'drive'), t('search', 'search', 'Search', S.view === 'search'), t('trash', 'trash', 'Trash', S.view === 'trash'), t('more', 'more', 'More', more));
}
function mAct(icon, label, on, danger) { return h('button', { class: 'm-act' + (danger ? ' danger' : ''), onclick: on }, h('span', { class: 'pill' }, svg(icon)), h('span', { class: 'lb' }, label)); }
function mSelBar() {
  const trash = S.view === 'trash', sel = selectedItems(), one = sel.length === 1 ? sel[0] : null, a = [];
  if (trash) {
    a.push(mAct('restore', 'Restore', async () => { await api('POST', '/api/trash/restore', { ids: [...S.sel] }); toast('Restored'); S.sel.clear(); load(); }));
    if (isAdminUser()) a.push(mAct('trash', 'Delete forever', async () => { if (await confirmBox('Delete forever?', 'This cannot be undone.', 'Delete forever', true)) { await api('POST', '/api/trash/purge', { ids: [...S.sel] }); S.sel.clear(); load(); } }, true));
  } else {
    if (one && !isFolder(one)) a.push(mAct('download', 'Download', () => download(fileUrl(pathOf(one), true))));
    else if (S.tools.zip) a.push(mAct('download', 'As zip', () => zipDownload(sel)));
    if (canEdit()) { a.push(mAct('move', 'Move', moveSel)); a.push(mAct('trash', 'Delete', deleteSel, true)); }
    const rows = [];
    if (canEdit() && one) rows.push({ icon: '✏️', label: 'Rename', on: () => renameItem(one) });
    if (canEdit() && S.tools.zip) rows.push({ icon: '🗜️', label: 'Compress to zip', on: () => compressSel(sel) });
    if (canEdit() && one && one.kind === 'archive' && S.tools.archive) rows.push({ icon: '📦', label: 'Extract…', on: () => extractDialog(one) });
    if (rows.length) a.push(mAct('more', 'More', () => sheet(`${sel.length} selected`, rows)));
  }
  return h('nav', { class: 'm-tabs m-selbar' }, a);
}

// ---- screens ----
function mQuotaChip() {
  const st = S.stats; if (!st) return null;
  const used = st.total - st.free, pct = st.total ? used / st.total * 100 : 0;
  return h('div', { class: 'm-quota' }, h('div', { class: 'bar ' + (pct > 90 ? 'bad' : pct > 75 ? 'warn' : '') }, h('i', { style: 'width:' + pct + '%' })), h('span', {}, `${fmtSize(used)} of ${fmtSize(st.total)} used`));
}
function mEmpty(main) {
  const trash = S.view === 'trash';
  main.append(h('div', { class: 'm-empty' }, h('div', { class: 'big' }, trash ? '🗑️' : S.view === 'search' ? '🔎' : '📂'), h('h3', {}, trash ? 'Trash is empty' : S.view === 'search' ? 'No matches' : 'This folder is empty'),
    h('p', {}, trash ? 'Deleted items wait here until an admin empties the trash.' : S.view === 'search' ? 'Try a different word.' : (canEdit() ? 'Tap ＋ to add photos, videos or files.' : 'Nothing here yet.'))));
}
function mFilesInto(host, items) {
  if (S.mode === 'list') { host.append(h('div', { class: 'm-list' }, items.map(mRow))); return; }
  const folders = items.filter(isFolder), files = items.filter(i => !isFolder(i));
  if (folders.length) host.append(h('div', { class: 'm-folders' }, folders.map(mFolderChip)));
  if (files.length) host.append(h('div', { class: 'm-grid' }, files.map(mTile)));
}
function mFiles(main) {
  if (S.view === 'drive' && !S.path) { const q = mQuotaChip(); if (q) main.append(q); }
  if (S.view === 'drive' && !S.user.totp && isAdminUser() && !sessionStorage.getItem('cd_2fa_nag')) main.append(h('div', { class: 'banner info' }, '🔐 Turn on two-step verification for better security. ', h('button', { class: 'btn small primary', onclick: twoFactorDialog }, 'Set up'), ' ', h('button', { class: 'btn small', onclick: e => { try { sessionStorage.setItem('cd_2fa_nag', '1'); } catch { /* ignore */ } e.target.closest('.banner').remove(); } }, 'Later')));
  if (!S.items.length) return mEmpty(main);
  mFilesInto(main, S.items);
}
let searchTimer = null;
function mSearch(main) {
  const box = h('div', { class: 'm-results' });
  const inp = h('input', { type: 'search', class: 'm-searchbox', placeholder: 'Search your cloud', value: S.query || '', enterKeyHint: 'search', autocomplete: 'off', autocapitalize: 'off',
    oninput: () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 350); }, onkeydown: e => { if (e.key === 'Enter') { clearTimeout(searchTimer); run(); } } });
  async function run() {
    const q = inp.value.trim(); S.query = q; box.replaceChildren();
    if (q.length < 2) { box.append(h('div', { class: 'm-empty' }, h('div', { class: 'big' }, '🔎'), h('p', {}, 'Type at least 2 letters to search every folder.'))); return; }
    box.append(h('div', { class: 'm-empty' }, h('p', {}, 'Searching…')));
    try { const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); if (inp.value.trim() !== q) return; S.items = r.items; box.replaceChildren(); if (!r.items.length) mEmpty(box); else mFilesInto(box, r.items); } catch (e) { box.replaceChildren(h('div', { class: 'm-empty' }, h('p', {}, e.message))); }
  }
  main.append(h('div', { class: 'm-searchwrap' }, svg('search'), inp), box);
  if (S.query && S.query.length >= 2) run(); else { box.append(h('div', { class: 'm-empty' }, h('div', { class: 'big' }, '🔎'), h('p', {}, 'Type at least 2 letters to search every folder.'))); setTimeout(() => inp.focus(), 50); }
}

function mRender() {
  storageGen++; clearInterval(storageTimer);
  if (!S.user) return renderLogin();
  const y = window.scrollY;
  const selecting = S.sel.size > 0 && ['drive', 'trash', 'search'].includes(S.view);
  const main = h('main', { id: 'main', class: 'm-main' }, alertsEl());
  const kids = [mTopBar(selecting), h('div', { class: 'm-ptr', id: 'm-ptr' }, '↓'), main];
  if (!selecting && S.view === 'drive' && canEdit()) kids.push(h('button', { class: 'm-fab', 'aria-label': 'Add', onclick: mNewSheet }, svg('plus')));
  kids.push(selecting ? mSelBar() : mTabs());
  $app.replaceChildren(h('div', { class: 'm-app' + (selecting ? ' selecting' : '') }, kids));
  if (S.view === 'storage') renderStorage(main);
  else if (S.view === 'users') renderUsers(main);
  else if (S.view === 'history') renderHistory(main);
  else if (S.view === 'activity') renderActivity(main);
  else if (S.view === 'search') mSearch(main);
  else mFiles(main);
  if (y) window.scrollTo(0, y);
}
render = function () { if (!isMobile()) return _render(); mRender(); };
mq.addEventListener('change', () => { if (S.user) render(); else renderLogin(); });

// ---- pull down to refresh ----
(function () {
  let y0 = null, dy = 0;
  addEventListener('touchstart', e => { y0 = (isMobile() && window.scrollY <= 0 && S.user && ['drive', 'trash'].includes(S.view) && !document.querySelector('.m-sheet-bg,.modal,.viewer') && e.touches.length === 1) ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; const p = document.getElementById('m-ptr'); if (p) { if (dy > 10) { p.style.height = Math.min(70, dy / 2) + 'px'; p.classList.toggle('ready', dy > 110); } else p.style.height = '0'; } }, { passive: true });
  addEventListener('touchend', () => { if (y0 == null) return; const p = document.getElementById('m-ptr'); if (p) { p.style.height = '0'; p.classList.remove('ready'); } if (dy > 110) { toast('Refreshing…'); load(); } y0 = null; });
})();

// ---- viewer: swipe left/right for next/previous, swipe down to close ----
viewer = function (list, idx) {
  _viewer(list, idx);
  if (!isMobile()) return;
  const vs = document.querySelectorAll('.viewer'), v = vs[vs.length - 1]; if (!v) return;
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  let x0 = 0, y0 = 0, t0 = 0, multi = false;
  v.addEventListener('touchstart', e => { multi = e.touches.length > 1; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  v.addEventListener('touchmove', e => { if (e.touches.length > 1) multi = true; }, { passive: true });
  v.addEventListener('touchend', e => {
    if (multi || (window.visualViewport && window.visualViewport.scale > 1.05) || e.target.closest('video,audio,iframe,input,button,.archlist')) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 60 && Date.now() - t0 < 700) key(dx < 0 ? 'ArrowRight' : 'ArrowLeft');
    else if (dy > 110 && Math.abs(dx) < 70) key('Escape');
  });
};

// ---- self-fitting: if the page ever ends up zoomed in or the phone is turned, snap back to "fits the screen" ----
function fitScreen() {
  const m = document.querySelector('meta[name=viewport]'); if (!m) return;
  const orig = m.content;
  m.content = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
  setTimeout(() => { m.content = orig; }, 300);
}
let fitTimer = null;
function maybeFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { const vv = window.visualViewport; if (isMobile() && vv && vv.scale > 1.03 && !document.querySelector('.viewer')) fitScreen(); }, 900);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', maybeFit);
addEventListener('orientationchange', () => setTimeout(fitScreen, 350));
addEventListener('resize', () => { if (isMobile() && S.user) { clearTimeout(window.__rr); window.__rr = setTimeout(render, 250); } });
if (PHOTOS) addEventListener('load', boot); else boot();

// no text selection / long-press menu anywhere except typing boxes
(() => {
  const typing = t => t && t.closest && t.closest('input,textarea,[contenteditable=true]');
  document.addEventListener('selectstart', e => { if (!typing(e.target)) e.preventDefault(); }, true);
  document.addEventListener('contextmenu', e => { if (!typing(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', e => { if (!typing(e.target)) e.preventDefault(); }, true);
  document.addEventListener('selectionchange', () => { const s = getSelection(); if (s && !s.isCollapsed && !typing(document.activeElement)) s.removeAllRanges(); });
})();
'use strict';
// Damaniya Cloud service worker: makes the app installable and makes it open instantly.
// It never stores anything from /api (your files and data are never cached on the phone by this).
const VERSION = 'dc-v9';
const SHELL = ['./', 'app.js', 'style.css', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.endsWith('/address.json')) return;
  // newest version first (so fixes show up at once); the saved copy is used when the network is slow or offline
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    try { return await Promise.race([net, new Promise((_, rej) => setTimeout(rej, 2500))]); }
    catch {
      const cached = await cache.match(e.request);
      if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
      try { return await net; } catch { return e.request.mode === 'navigate' ? (await cache.match('./')) || Response.error() : Response.error(); }
    }
  })());
});
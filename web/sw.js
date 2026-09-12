// App-shell cache so Astha still opens (voice commands, memory UI) with a weak or lost connection.
// Camera, screen-share and API calls are never cached — only the static shell.
const CACHE = 'astha-shell-e4916b0321';
// Relative to this file's own location, so this still works when the app is served from a
// subpath (e.g. a GitHub Pages project site at /astha/) rather than a domain's root.
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache live API/audio/vision calls
  // Model weights are cached by their own runtimes (IndexedDB for the detector, the Cache API for
  // Transformers.js and Tesseract); caching them here again would double the storage used.
  if (/huggingface\.co$|\.hf\.co$|cdn-lfs|tfhub\.dev$|kaggle|storage\.googleapis\.com$|tessdata/.test(url.hostname + url.pathname)) return;
  if (e.request.method !== 'GET') return;
  // The page itself is network-first: a new build must show up on the very next open, not the
  // one after. Cache is only the fallback for when the network is down.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request).then(c => c || caches.match('./'))));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => cached))
  );
});

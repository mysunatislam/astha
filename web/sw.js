// Cache only approved static resources. API responses and private audio are never cached.
const CACHE = 'astha-shell-fb14ece186';
const SHELL = ['./', './index.html', './config.js', './backend.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const RUNTIMES = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.webgpu.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
];
const shellUrls = new Set(SHELL.map(path => new URL(path, self.location.href).href));
const runtimeUrls = new Set(RUNTIMES);
function cacheable(response) { return response?.ok && response.type !== 'opaque' && response.type !== 'opaqueredirect'; }
function fetchDeadline() {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(8000);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 8000); return controller.signal;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // A CDN failure must not prevent the local shell from installing.
    await Promise.allSettled(RUNTIMES.map(url => cache.add(new Request(url, { mode: 'cors', credentials: 'omit', signal: fetchDeadline() }))));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('astha-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || /(^|\/)api(\/|$)/.test(url.pathname)) return;
  const sameOrigin = url.origin === self.location.origin;
  const navigation = sameOrigin && request.mode === 'navigate' && url.pathname.startsWith(new URL('./', self.location.href).pathname);
  const approved = shellUrls.has(url.href) || runtimeUrls.has(url.href);
  if (!navigation && !approved) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fallback = await cache.match(request) || (navigation ? await cache.match(new URL('./', self.location.href).href) : undefined);
    // Keep HTML and its bootstrap scripts on one installed shell version until activation.
    if (fallback) return fallback;
    try {
      const response = await fetch(request, { signal: fetchDeadline() });
      if (cacheable(response)) {
        if (approved) await cache.put(request, response.clone());
        return response;
      }
      return fallback || response;
    } catch (e) {
      return fallback || new Response('Offline resource unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

// PrivacyScript Service Worker
// Caches the app shell for offline use. The NER model is already cached by
// Transformers.js in IndexedDB — the SW only needs to cache the HTML/JS/CSS
// shell so the UI loads even when the network is unavailable.

const CACHE_NAME = 'privacyscript-v2';

// App shell resources to pre-cache on install.
// Next.js static export produces index.html + _next/static/**
const SHELL_PATTERNS = [
  /^\/privacyscript\/?$/,
  /^\/privacyscript\/process\/?$/,
  /^\/privacyscript\/review\/?$/,
  /^\/privacyscript\/output\/?$/,
  /\/_next\/static\//,
  /\/privacyscript\/wasm\//,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(['/privacyscript/', '/privacyscript/process/', '/privacyscript/review/', '/privacyscript/output/'])
    ).catch(() => {
      // Pre-cache failure is non-fatal on first install (e.g. offline first load).
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const matches = SHELL_PATTERNS.some((p) => p.test(url.pathname));
  if (!matches) return; // Let all non-shell requests (CDN model files, etc.) pass through.

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

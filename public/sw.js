// PrivacyScript Service Worker
//
// Caching strategy:
//   - /_next/static/** files are content-hashed by the build → cache-first is
//     safe (a changed file always gets a new URL).
//   - Pages and WASM binaries are NOT content-hashed → network-first, with the
//     cache only as an offline fallback. Cache-first here pinned users to a
//     stale build after every deploy: the cached HTML referenced chunk hashes
//     that no longer existed, producing a permanently blank app.
//   - Next router payload fetches (RSC / prefetch) are never intercepted.
//     Answering them with cached HTML breaks client-side navigation and forces
//     a full page load, which wipes the in-memory session mid-flow.

const CACHE_NAME = 'privacyscript-v3';

const STATIC_ASSET = /\/_next\/static\//;
const OFFLINE_SHELL = [
  /^\/privacyscript\/?$/,
  /^\/privacyscript\/(process|review|output|batch|check)(\/report)?\/?$/,
  /\/privacyscript\/wasm\//,
  /\/privacyscript\/tesseract\//,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll([
          '/privacyscript/',
          '/privacyscript/process/',
          '/privacyscript/review/',
          '/privacyscript/output/',
        ])
      )
      .catch(() => {
        // Pre-cache failure is non-fatal on first install (e.g. offline first load).
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Never touch Next router payload fetches — see header comment.
  if (req.headers.get('RSC') || req.headers.get('Next-Router-Prefetch')) return;

  const url = new URL(req.url);

  if (STATIC_ASSET.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === 'navigate' || OFFLINE_SHELL.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const response = await fetch(req);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, response.clone());
  }
  return response;
}

async function networkFirst(req) {
  try {
    const response = await fetch(req);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw err;
  }
}

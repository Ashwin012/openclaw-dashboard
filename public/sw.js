const CACHE_NAME = 'dev-dashboard-v5';

const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: only cache truly static assets (no auth needed)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network first for everything, cache static assets on success
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  
  // API calls: always network, never cache
  if (url.pathname.startsWith('/api/')) return;

  // Everything else: network first
  event.respondWith(
    fetch(request).then(response => {
      // Only cache successful responses for static assets
      if (response.ok && (url.pathname.match(/\.(png|jpg|svg|ico|css|js|woff2?|ttf)$/) || STATIC_ASSETS.includes(url.pathname))) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

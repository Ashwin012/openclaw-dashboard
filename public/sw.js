const CACHE_NAME = 'dev-dashboard-v2';

const STATIC_ASSETS = [
  '/manifest.json',
  '/css/style.css',
  '/icon-192.png',
  '/icon-512.png'
];

const HTML_PAGES = [
  '/home.html',
  '/dashboard.html',
  '/project.html',
  '/chat.html',
  '/login.html',
  '/profile.html'
];

// Install: cache static assets and HTML pages
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([...STATIC_ASSETS, ...HTML_PAGES]).catch(() => {
        // Cache what we can, ignore failures (e.g. network offline)
      });
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

// Fetch strategy:
// - API calls: network only
// - Static assets (CSS, images, manifest): cache first, fallback to network
// - HTML pages: network first, fallback to cache
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and cross-origin
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API calls: network only
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: cache first
  const isStatic = STATIC_ASSETS.some(a => url.pathname === a) ||
    url.pathname.match(/\.(png|jpg|svg|ico|woff2?|ttf)$/);
  if (isStatic) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML pages: network first, fallback to cache
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

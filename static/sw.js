const CACHE_NAME = 'media-hub-v1';
const PRECACHE_ASSETS = [
  '/',
  '/static/index.html',
  '/static/style.css?v=16',
  '/static/app.js?v=16',
  '/static/manifest.json',
  '/manifest.json',
  '/static/favicon.ico',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/icon-192-maskable.png',
  '/static/icon-512-maskable.png',
  '/static/apple-touch-icon.png'
];

// Install event - cache core shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Precache partial error:', err);
      });
    })
  );
});

// Activate event - claim clients & clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - Network-first with cache fallback, bypass API and WebSocket
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API routes, WebSocket, or non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/docs') ||
    url.pathname.startsWith('/openapi.json')
  ) {
    return;
  }

  // For app navigation and static assets: Network-first with Cache fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        if (event.request.mode === 'navigate') {
          return caches.match('/static/index.html') || caches.match('/');
        }
        return new Response('Network unavailable', { status: 503, statusText: 'Offline' });
      })
  );
});

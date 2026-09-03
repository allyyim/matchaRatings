const CACHE_NAME = 'sip-score-cache';
const urlsToCache = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json'
];

// Version file to check for updates
const VERSION_URL = '/version.json';

// Install event - cache essential files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Check for updates periodically
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_FOR_UPDATES') {
    checkForUpdates();
  }
});

async function checkForUpdates() {
  try {
    const response = await fetch(VERSION_URL);
    const data = await response.json();
    const newVersion = data.version;

    // Store current version
    const cache = await caches.open(CACHE_NAME);
    const versionResponse = await cache.match(VERSION_URL);
    const currentVersionData = versionResponse ? await versionResponse.json() : { version: 'unknown' };
    const currentVersion = currentVersionData.version;

    if (newVersion !== currentVersion) {
      // New version available - update cache
      await cache.addAll(urlsToCache);

      // Notify all clients about the update
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'APP_UPDATED',
          version: newVersion
        });
      });
    }
  } catch (error) {
    console.log('Update check failed:', error);
  }
}

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip API calls - always go to network
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return new Response(
            JSON.stringify({ error: 'Offline - API unavailable' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // For everything else, try cache first, then network
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).then(response => {
        // Cache successful responses for next time
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        // Return cached version if network fails
        return caches.match(event.request);
      });
    })
  );
});

// CACHE_NAME is rewritten at deploy time by .github/workflows/deploy.yml
// to the current git commit SHA so every push invalidates the cache and
// triggers an auto-reload in the PWA.
const CACHE_NAME = 'sip-score-cache-dev';
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
            console.log('Deleting old cache:', cacheName);
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
    const response = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!response.ok) return;

    const data = await response.json();
    const newVersion = data.version;

    // Get cached version
    const cache = await caches.open(CACHE_NAME);
    const versionResponse = await cache.match(VERSION_URL);
    const currentVersionData = versionResponse ? await versionResponse.json() : { version: 'unknown' };
    const currentVersion = currentVersionData.version;

    if (newVersion !== currentVersion) {
      console.log('App version updated:', currentVersion, '->', newVersion);
      // Silently update cache in background - do NOT notify or reload
      // This allows users to stay logged in until they manually refresh
      try {
        await cache.addAll(urlsToCache);
        await cache.delete(VERSION_URL);
        await cache.add(VERSION_URL);
      } catch (error) {
        console.log('Cache update failed:', error);
      }

      // Optional: Log that update is ready, but don't force reload
      // This gives users time to save work before they refresh manually
    }
  } catch (error) {
    console.log('Update check failed:', error);
  }
}

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip API calls - always go to network for fresh data
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => {
          return new Response(
            JSON.stringify({ error: 'Offline - API unavailable' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // For HTML files, always check network first for updates
  if (event.request.method === 'GET' && (event.request.url.endsWith('/') || event.request.url.endsWith('/index.html'))) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // For everything else, try cache first, then network
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        return caches.match(event.request);
      });
    })
  );
});

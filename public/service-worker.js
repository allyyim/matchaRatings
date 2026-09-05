// CACHE_NAME is rewritten at deploy time by .github/workflows/deploy.yml
// to the current git commit SHA so every push invalidates the cache and
// triggers an auto-reload in the PWA.
const CACHE_NAME = 'sip-score-cache-dev';
const RUNTIME_CACHE = CACHE_NAME + '-runtime';
const API_CACHE = CACHE_NAME + '-api';

const urlsToCache = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json'
];

// Version file to check for updates
const VERSION_URL = '/version.json';

// How long a stale API cache entry may be served before we insist on the
// network. 10 minutes is a good balance for a low-churn dataset like
// ratings/follows/preferences: fresh enough to feel live, tolerant enough
// to survive brief network handoffs.
const API_STALE_LIMIT_MS = 10 * 60 * 1000;
// Network-first attempt cap for API calls before falling back to cache.
// Kept short so a flaky mobile network doesn't wall the UI.
const API_NETWORK_TIMEOUT_MS = 3000;

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
          // Keep the current shell cache + its runtime/api siblings.
          if (cacheName === CACHE_NAME || cacheName === RUNTIME_CACHE || cacheName === API_CACHE) {
            return undefined;
          }
          console.log('Deleting old cache:', cacheName);
          return caches.delete(cacheName);
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
      try {
        await cache.addAll(urlsToCache);
        await cache.delete(VERSION_URL);
        await cache.add(VERSION_URL);
      } catch (error) {
        console.log('Cache update failed:', error);
      }
    }
  } catch (error) {
    console.log('Update check failed:', error);
  }
}

// --- helpers ---------------------------------------------------------------

function isHtmlNavigation(request) {
  if (request.mode === 'navigate') return true;
  const url = request.url;
  return request.method === 'GET' && (url.endsWith('/') || url.endsWith('/index.html'));
}

function isApiRequest(url) {
  return url.includes('/api/');
}

function timestampedResponse(response, ts) {
  // Clone body + wrap with a header we can read back to know cache age.
  const headers = new Headers(response.headers);
  headers.set('x-sw-cached-at', String(ts));
  return response.blob().then(body => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }));
}

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);

  // Race: real fetch vs a short timeout that resolves to null so we can
  // fall back to cache without waiting the full browser HTTP timeout.
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(null), API_NETWORK_TIMEOUT_MS);
  });

  try {
    const network = fetch(request, { cache: 'no-store' })
      .then(async response => {
        // Only cache successful, cacheable responses. Skip opaque or errors.
        if (response && response.ok && response.type !== 'opaque') {
          const stamped = await timestampedResponse(response.clone(), Date.now());
          cache.put(request, stamped).catch(() => {});
        }
        return response;
      });

    const winner = await Promise.race([network, timeout]);
    if (winner) {
      clearTimeout(timeoutId);
      return winner;
    }

    // Timeout won: try cache, but if nothing there, keep waiting on the
    // real network so we still deliver something if it eventually returns.
    const cached = await cache.match(request);
    if (cached) return cached;
    return network;
  } catch (err) {
    clearTimeout(timeoutId);
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Offline - API unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstHtml(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request) || await cache.match('/index.html') || await cache.match('/');

  // Kick off a background revalidate so next launch has fresh HTML,
  // but paint the cached copy immediately if we have it.
  const networkUpdate = fetch(request, { cache: 'no-store' })
    .then(response => {
      if (response && response.status === 200) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Fire-and-forget the revalidate.
    networkUpdate.catch(() => {});
    return cached;
  }

  const fresh = await networkUpdate;
  if (fresh) return fresh;
  return new Response('<h1>Offline</h1><p>Sip &amp; Score is offline and no cached copy is available yet.</p>', {
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function cacheFirstAsset(request) {
  const runtime = await caches.open(RUNTIME_CACHE);
  const shell = await caches.open(CACHE_NAME);
  const cached = await runtime.match(request) || await shell.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
      runtime.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // Nothing we can do for a missing asset offline.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// --- fetch router ----------------------------------------------------------

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = request.url;

  // Mutations must always go to the network - never cache POST/PUT/DELETE.
  if (request.method !== 'GET') {
    if (isApiRequest(url)) {
      event.respondWith(
        fetch(request).catch(() => new Response(
          JSON.stringify({ error: 'Offline - change will be lost' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
      );
    }
    return;
  }

  // /api/* GETs: network-first with a short timeout, then stale cache.
  if (isApiRequest(url)) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // HTML shell: cache-first with background revalidation so first paint
  // is instant offline. Fresh HTML lands on next launch.
  if (isHtmlNavigation(request)) {
    event.respondWith(cacheFirstHtml(request));
    return;
  }

  // Everything else (hashed JS/CSS/images/fonts): cache-first, populate
  // runtime cache on miss.
  event.respondWith(cacheFirstAsset(request));
});

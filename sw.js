/* ═══════════════════════════════════════════════════════════════════
   Метеощоденник — Service Worker v7
   Стратегія: Cache-First для статики, Network-First для API.
   ═══════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'meteo-v7.0.0';
const CACHE_STATIC  = `${CACHE_VERSION}-static`;
const CACHE_RUNTIME = `${CACHE_VERSION}-runtime`;

/* Файли, які кешуємо при встановленні (offline shell) */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json'
];

/* Домени API — для них використовуємо Network-First (щоб не отримувати застарілі дані) */
const API_HOSTS = [
  'api.open-meteo.com',
  'archive-api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'nominatim.openstreetmap.org'
];

/* ─────────── INSTALL: попереднє кешування ─────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Precache частково не вдався:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

/* ─────────── ACTIVATE: очищення старих кешів ─────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('meteo-') && k !== CACHE_STATIC && k !== CACHE_RUNTIME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ─────────── FETCH: перехоплення запитів ─────────── */
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ігноруємо не-GET та chrome-extension
  if (req.method !== 'GET') return;
  if (req.url.startsWith('chrome-extension://')) return;
  if (req.url.startsWith('moz-extension://')) return;

  const url = new URL(req.url);

  // API: Network-First з fallback у кеш
  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Google Fonts: Cache-First (рідко змінюються)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, CACHE_RUNTIME));
    return;
  }

  // Усі інші (наші файли): Cache-First з оновленням у фоні
  event.respondWith(staleWhileRevalidate(req, CACHE_STATIC));
});

/* ─────────── Стратегії ─────────── */

/** Network-First: спочатку мережа, при помилці — кеш */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const cache = await caches.open(CACHE_RUNTIME);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', message: 'Немає з\'єднання' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/** Cache-First: спочатку кеш, потім мережа */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type !== 'opaque') {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504 });
  }
}

/** Stale-While-Revalidate: миттєво з кешу + фонове оновлення */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req)
    .then(res => {
      if (res && res.status === 200) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response('', { status: 504 });
}

/* ─────────── Повідомлення від клієнта ─────────── */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
  }
});

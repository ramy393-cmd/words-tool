// service-worker.js — MBA Vocabulary PWA
// Strategy: stale-while-revalidate for pages, network-first for API

const CACHE_VERSION = "v1.0.4"; // bump this on every deploy
const STATIC_CACHE  = `vocab-static-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json"
];

// ── Install: pre-cache static assets ─────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener("fetch", event => {
  const url = event.request.url;

  // Always bypass for Google Apps Script API calls
  if (url.includes("script.google.com")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // POST requests — always network
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.open(STATIC_CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request).then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          cache.put(event.request, networkRes.clone());
        }
        return networkRes;
      }).catch(() => null);

      return cached || fetchPromise;
    })
  );
});

// service-worker.js — MBA Vocabulary PWA
// Strategy: stale-while-revalidate for pages, network-first for API

const CACHE_VERSION = "v1.0.7"; // bump this on every deploy
const STATIC_CACHE  = `vocab-static-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json"
];

// URLs that must always bypass the service worker cache entirely.
// This is critical: the PING connectivity check MUST reach the real network
// or false-offline startup (BUG 1) occurs when a cached 200 is returned.
function isBypassUrl(url) {
  return (
    url.includes("script.google.com") ||
    url.includes("googleapis.com") ||
    url.includes("google.com/macros") ||
    // catch redirect destinations that Apps Script resolves to
    url.includes("script.googleusercontent.com")
  );
}

// Requests that must never be served from cache (connectivity probes, etc.)
function isNoCacheRequest(request) {
  // cache: "no-store" requests must always go to network
  if (request.cache === "no-store") return true;
  // PING action must always go to network — never return stale 200
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("action") === "PING") return true;
  } catch (_) {}
  return false;
}

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

  // Always bypass for API/Google calls — never cache, never intercept
  if (isBypassUrl(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // POST requests — always network
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  // Connectivity probes and no-store requests — always network, never cache
  if (isNoCacheRequest(event.request)) {
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

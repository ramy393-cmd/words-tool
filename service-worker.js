const CACHE_NAME = "words-tool-v2"; // غير الرقم كل مرة تحدث

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

/* INSTALL */
self.addEventListener("install", e => {
  self.skipWaiting(); // يخلي التحديث فوري

  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
  );
});

/* ACTIVATE */
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key); // يمسح القديم
          }
        })
      )
    )
  );

  self.clients.claim(); // يطبق التحديث فورًا
});

/* FETCH */
self.addEventListener("fetch", e => {
  const req = e.request;

  // تجاهل API calls (مهم جداً)
  if (req.url.includes("script.google.com")) return;

  // Network First للـ HTML (عشان التحديثات)
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(req, res.clone());
            return res;
          });
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache First لباقي الملفات
  e.respondWith(
    caches.match(req).then(res => {
      return res || fetch(req).then(fetchRes => {
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(req, fetchRes.clone());
          return fetchRes;
        });
      });
    })
  );
});
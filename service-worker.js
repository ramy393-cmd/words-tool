const CACHE="words-tool-final-pro";

self.addEventListener("install",e=>{
self.skipWaiting();
e.waitUntil(caches.open(CACHE).then(c=>c.addAll(["./","./index.html","./manifest.json"])));
});

self.addEventListener("activate",e=>{
e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>k!==CACHE && caches.delete(k)))));
self.clients.claim();
});

self.addEventListener("fetch",e=>{
if(e.request.url.includes("script.google.com")){
e.respondWith(fetch(e.request).catch(()=>new Response(JSON.stringify({data:[]}),{headers:{"Content-Type":"application/json"}})));
return;
}
e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
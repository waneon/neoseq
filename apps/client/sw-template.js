// Neoseq application-shell Service Worker (generated at build time).
//
// Scope: shell assets only (HTML, JS, CSS, Wasm). Canonical graph data is
// owned by the Worker-side IndexedDB repository and is never cached here.
//
// Strategy: the built shell assets are precached at install; navigations
// are network-first with cached-shell fallback so deployments propagate
// while offline reloads still boot; only generated shell assets are cache-first.

const CACHE = "__CACHE_NAME__";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/", { ignoreVary: true }).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Remote graph APIs are intentionally outside the application-shell cache.
  // Restricting interception to the generated precache also keeps future data
  // endpoints from accidentally acquiring cache-first semantics.
  if (!PRECACHE.includes(url.pathname)) return;

  event.respondWith(
    caches.match(request, { ignoreVary: true }).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

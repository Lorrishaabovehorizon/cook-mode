/*
 * sw.js — Service Worker for Cook Mode (offline app shell).
 *
 * Strategy: pre-cache the app shell on install, then serve cache-first with a
 * network fallback. This means the recipe and Cook Mode keep working at the
 * stove even when the connection drops (a key point from Task 7.3HD).
 */
const CACHE = "cookmode-v1";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/recipes.js",
  "./js/app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Remove old caches when the version changes.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request)
        .then((res) => {
          // Cache same-origin successful responses for next time.
          const copy = res.clone();
          if (res.ok && new URL(event.request.url).origin === location.origin) {
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached)   // offline and not cached → undefined (handled by browser)
    )
  );
});

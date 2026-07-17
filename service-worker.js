// Bumping CACHE_NAME invalidates old caches on next load.
const CACHE_NAME = "medrecall-v21";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles.css",
  "./app.js",
  "./docx-builder.js",
  "./pdf-builder.js",
  "./config.js",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app's own files: always fetch the latest version when
// online (so edits you push to GitHub show up on next reload without needing a
// cache-version bump), and only fall back to the cached copy when offline.
// Cross-origin requests (Google APIs, the Whisper model/CDN) are left alone.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

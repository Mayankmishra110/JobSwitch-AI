// PWA app shell - deliberately minimal. Every page here is server-rendered
// per request against live data (job applications, matches, a live SSE
// stream) - caching THOSE would mean showing a candidate stale or wrong
// data while offline, which is worse than an honest "you're offline" state.
// What this actually caches: the static assets an offline launch needs to
// show something at all, not a promise of full offline data.
const CACHE_NAME = 'jobswitch-shell-v1';
const SHELL_ASSETS = ['/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first, falling back to the cached shell asset if present and the
// network is genuinely unreachable - never falls back for a navigation
// request (an HTML page), since serving a stale dashboard page offline
// would look like live data.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') return; // let the browser's own offline error show, honestly
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((res) => res ?? Response.error())),
  );
});

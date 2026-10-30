// Service worker template. vite.config.ts fills in the version and file list.
//
// - Precaches every built file on install, so the app opens with no network.
// - Page loads: network first (fresh deploys show up), cache when offline.
// - Hashed assets: cache first.
// - Only handles URLs inside its own folder. Production lives at /cg-tracker/
//   and branch previews at /cg-tracker/preview/<b>/ on the same origin; the
//   production worker must not answer for previews (and vice versa caches are
//   named per scope, so neither deletes the other's cache).
const VERSION = '__VERSION__';
const FILES = __FILES__;
const SCOPE = new URL(self.registration.scope).pathname;
const PREFIX = `cg-tracker:${SCOPE}:`;
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function mine(url) {
  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith(SCOPE) &&
    !url.pathname.slice(SCOPE.length).startsWith('preview/')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!mine(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./', { cacheName: CACHE }).then((r) => r || caches.match(req))),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

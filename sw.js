/* Service worker — makes the metronome work with no network at all.
 *
 * A practice room is exactly where the wifi is worst, so the app shell is
 * precached on install and served cache-first afterwards. Nothing here is
 * user data: presets live in localStorage and never touch the cache.
 *
 * Bump CACHE whenever the shell changes; the old cache is deleted on activate.
 */
const CACHE = 'drbeat21-v3';

/* Relative URLs so this works both at a domain root and under a project-site
 * subpath like /DrBeat21/ — an absolute '/index.html' would 404 under the latter. */
const SHELL = [
  '.',
  'index.html',
  'css/style.css',
  'js/mic.js',
  'js/voices.js',
  'js/engine.js',
  'js/coach.js',
  'js/midi.js',
  'js/presets.js',
  'js/sessions.js',
  'js/takes.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is all-or-nothing; one 404 would leave the app with no cache at
    // all, so each entry is allowed to fail on its own.
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        console.warn('[sw] could not precache', url, e);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // A navigation must always resolve to the app, even offline and even when the
  // URL carries a query string the cache has never seen.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('index.html')) || (await cache.match('.')) || Response.error();
      }
    })());
    return;
  }

  if (sameOrigin) {
    // Shell files are versioned by the cache name, so cache-first is safe and
    // keeps startup instant.
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  /* Google Fonts: serve what we have, refresh in the background. The page
   * declares real fallback stacks, so a miss degrades the type rather than
   * breaking anything. */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      // Opaque cross-origin responses are still worth storing for offline use.
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});

// Only the application shell is cached. User data and credentials never enter
// CacheStorage; cloud data is stored separately by sync-storage.js.
const CACHE_PREFIX = 'weekprofiler-shell-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-19-v11';
const ASSETS = new Map([
  ['/', 'text/html'],
  ['/app.js', 'javascript'],
  ['/week.js', 'javascript'],
  ['/tracking.js', 'javascript'],
  ['/time-shares.js', 'javascript'],
  ['/plan-links.js', 'javascript'],
  ['/plan-matching.mjs', 'javascript'],
  ['/tracking-model.js', 'javascript'],
  ['/tracking.mjs', 'javascript'],
  ['/model.js', 'javascript'],
  ['/ai.js', 'javascript'],
  ['/ai-model.js', 'javascript'],
  ['/cloud-sync.js', 'javascript'],
  ['/sync-storage.js', 'javascript'],
  ['/sync-model.js', 'javascript'],
  ['/style.css', 'text/css'],
  ['/icon.svg', 'image/svg+xml'],
  ['/weekmark-180.png', 'image/png'],
  ['/weekmark-192.png', 'image/png'],
  ['/weekmark-512.png', 'image/png'],
  ['/manifest.webmanifest', 'application/manifest+json'],
]);

async function cacheableShell(response, pathname) {
  if (!response.ok || response.redirected || !['basic', 'default'].includes(response.type)) return false;
  if (!response.headers.get('Content-Type')?.toLowerCase().includes(ASSETS.get(pathname))) return false;
  if (pathname === '/') {
    const html = await response.clone().text();
    // Access login HTML can return 200. Require both known application markers.
    return /<title>周谱 · weekprofiler<\/title>/.test(html)
      && /<script\b[^>]*\bsrc=["']\/app\.js["']/.test(html)
      && /\bid=["']app["']/.test(html);
  }
  return true;
}

self.addEventListener('install', event => {
  // Do not call skipWaiting: an open page may have unsaved work or an old schema.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all([...ASSETS].map(async ([path]) => {
      try {
        const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
        if (await cacheableShell(response, path)) await cache.put(path, response);
      } catch {} // First-use network failure must not break the current page.
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // In particular, never intercept /api, /cdn-cgi/access, login or third parties.
  if (request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.has(url.pathname) || url.search) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME).catch(() => null);
    try {
      const response = await fetch(request);
      if (cache && await cacheableShell(response, url.pathname)) {
        // A full/disabled cache must not turn a successful online load into an error.
        await cache.put(url.pathname, response.clone()).catch(() => {});
      }
      // Authentication failures and redirects are returned, never hidden by cache.
      return response;
    } catch (error) {
      const cached = await cache?.match(url.pathname).catch(() => null);
      if (cached) return cached;
      throw error;
    }
  })());
});

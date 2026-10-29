/// <reference lib="webworker" />
// Service worker: makes the app shell and cover art available offline.
// Audio is stored by the page itself (IndexedDB), so it never goes through
// here. Updates wait until the user reloads, so music is never interrupted.

declare const self: ServiceWorkerGlobalScope & {
  __PRECACHE__: string[];
  __SW_VERSION__: string;
};

const PRECACHE: string[] = self.__PRECACHE__;
const VERSION: string = self.__SW_VERSION__;
const SHELL = `syncmusic-shell-${VERSION}`;
const COVERS = 'syncmusic-covers-v1';
const MAX_COVERS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('syncmusic-shell-') && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

async function trimCovers(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_COVERS; i++) await cache.delete(keys[i]!);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // App shell: always the cached index.html, network as a fallback.
    event.respondWith(
      (async () => {
        const cached = await caches.match('/', { cacheName: SHELL });
        if (cached) return cached;
        return fetch(req);
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/api/tracks/') && url.pathname.endsWith('/cover')) {
    // Covers carry a revision in the URL, so a cached copy is always valid.
    event.respondWith(
      (async () => {
        const cache = await caches.open(COVERS);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          await cache.put(req, res.clone());
          void trimCovers(cache);
        }
        return res;
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return; // live data, audio: network only

  event.respondWith(
    (async () => {
      const hit = await caches.match(req, { cacheName: SHELL });
      return hit ?? fetch(req);
    })(),
  );
});

export {};

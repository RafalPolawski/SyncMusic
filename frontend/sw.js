// ─── Auto-injected precache manifest by vite-plugin-pwa at build time ───────
// During `npm run build`, this placeholder is replaced with the full list of
// hashed Vite output assets (js, css, html, icons).
// In dev mode this is an empty array.
const precacheManifest = self.__WB_MANIFEST || [];

const CACHE_VERSION = 'v7';
const CACHE_NAME = `syncmusic-cache-${CACHE_VERSION}`;

// Bare minimum shell — only guaranteed to be available at install time.
// /api/songs is NOT here: server may be offline when SW first installs.
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // Cache static shell
        await cache.addAll(SHELL_ASSETS).catch(() => {});
        // Cache all Vite-generated assets from the precache manifest (production build)
        await Promise.all(
            precacheManifest.map(({ url, revision }) => {
                const req = revision ? new Request(`${url}?__WB_REVISION__=${revision}`) : new Request(url);
                return fetch(req).then(r => r.ok ? cache.put(new Request(url), r) : null).catch(() => null);
            })
        );
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((n) => n !== CACHE_NAME).map((n) => {
                    console.log('[SW] Deleting old cache:', n);
                    return caches.delete(n);
                })
            ))
            .then(() => self.clients.claim())
    );
});

// ─── Fetch strategy ───────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const { pathname } = url;

    // Only handle same-origin requests (skip cross-origin like Google Fonts CDN in network mode)
    if (url.origin !== self.location.origin) return;

    // ── /music/* — Cache-first: enables offline playback of cached songs
    if (pathname.startsWith('/music/')) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    // ── Cover art — Cache-first (small files, rarely change)
    if (pathname.startsWith('/api/cover')) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    // ── Songs library — Stale-while-revalidate
    // Returns cached data immediately → app loads offline.
    // Fetches fresh data in background when online.
    if (pathname === '/api/songs') {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // ── Skip live API calls (cert-hash, scan-status, rescan, etc.)
    if (pathname.startsWith('/api/')) return;

    // ── App shell + all JS/CSS assets — Network-first, fallback to cache
    // In production build, all assets are pre-cached in install step.
    // In dev mode, Vite serves them dynamically; we cache after first fetch.
    event.respondWith(networkFirstWithCache(event.request));
});

// ─── Cache strategies ─────────────────────────────────────────────────────────

/** Cache-first: great for immutable assets (audio files, album art) */
async function cacheFirst(request) {
    const cached = await caches.match(request); // exact match — ignoreSearch would break cover art
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res && res.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, res.clone());
        }
        return res;
    } catch {
        return new Response('', { status: 503, statusText: 'Offline – not cached' });
    }
}

/**
 * Stale-while-revalidate: return cache immediately, update in background.
 * Falls back to empty JSON array so the UI still renders offline.
 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request).then((res) => {
        if (res && res.status === 200) cache.put(request, res.clone());
        return res;
    }).catch(() => null);

    if (cached) {
        // Serve stale immediately; don't await network
        fetchPromise; // fire-and-forget
        return cached;
    }
    // No cache yet — wait for network (first visit)
    const netRes = await fetchPromise;
    if (netRes) return netRes;
    // Absolute fallback: empty library (no crash)
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Network-first with cache fallback.
 * Uses ignoreSearch so Vite's ?v= / ?t= query strings don't cause cache misses.
 */
async function networkFirstWithCache(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const res = await fetch(request);
        if (res && res.status === 200 && res.type !== 'opaque') {
            cache.put(request, res.clone());
        }
        return res;
    } catch {
        // ignoreSearch: true — matches cached /main.js?v=old when browser asks for /main.js?v=new
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            // SPA fallback: always return index.html for navigation
            const shell = await cache.match('/index.html');
            if (shell) return shell;
        }
        return new Response('', { status: 503, statusText: 'Offline' });
    }
}

// ─── Bulk playlist caching (triggered from UI) ────────────────────────────────

self.addEventListener('message', (event) => {
    if (!event.data || event.data.action !== 'cache_playlist') return;

    const { urls = [], cacheId = 'default' } = event.data;
    const total = urls.length;
    if (total === 0) return;

    const notify = (action, extra = {}) => {
        self.clients.matchAll().then((clients) =>
            clients.forEach((c) => c.postMessage({ action, total, cacheId, ...extra }))
        );
    };

    const process = async () => {
        const cache = await caches.open(CACHE_NAME);
        for (let i = 0; i < urls.length; i++) {
            const urlStr = urls[i];
            const req = new Request(urlStr);
            if (await cache.match(req)) {
                notify('cache_progress', { url: urlStr });
                continue;
            }
            try {
                // Abort request if it stalls for > 15s to keep the worker alive
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const res = await fetch(req, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res && res.status === 200) await cache.put(req, res.clone());
            } catch (e) {
                console.warn('[SW] cache_playlist failed:', urlStr, e);
            }
            notify('cache_progress', { url: urlStr });
        }
        notify('cache_done');
    };

    event.waitUntil(process());
});

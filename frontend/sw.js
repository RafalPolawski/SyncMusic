const CACHE_NAME = 'syncmusic-cache-v3';

// Assets to cache on installation
const STATIC_ASSETS = [
    '/',
    '/index.html'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Installed and caching static assets');
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Cover art — Cache First (small files, rarely change)
    if (url.pathname.startsWith('/api/cover')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((res) => {
                    if (res && res.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
                    }
                    return res;
                }).catch(() => new Response('', { status: 404 }));
            })
        );
        return;
    }

    // Audio files — Cache First with network fallback
    if (url.pathname.startsWith('/music/')) {
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    console.log('[SW] Serving audio from cache:', url.pathname);
                    return cachedResponse;
                }

                return fetch(event.request).then((networkResponse) => {
                    if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                        return networkResponse;
                    }

                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        console.log('[SW] Dynamically caching audio:', url.pathname);
                        cache.put(event.request, responseToCache);
                    });

                    return networkResponse;
                }).catch(() => {
                    console.log("[SW] Network failed, no cache available for:", url.pathname);
                });
            })
        );
        return;
    }

    // Default strategy: Network First -> Fallback to Cache
    event.respondWith(
        fetch(event.request).then((netRes) => {
            if (url.pathname.startsWith('/api/') ||
                url.pathname.startsWith('/src/') ||
                url.pathname.startsWith('/@vite/') ||
                url.pathname.startsWith('/node_modules/')) {
                return netRes;
            }

            if (netRes && netRes.status === 200 && netRes.type === 'basic') {
                const responseToCache = netRes.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
            }

            return netRes;
        }).catch(() => {
            console.log('[SW] Network failed, falling back to cache for:', url.pathname);
            return caches.match(event.request);
        })
    );
});


// Listen for messages from the client
self.addEventListener('message', (event) => {

    // Pre-cache next N tracks (existing feature, used by player.js)
    if (event.data && event.data.action === 'precache') {
        const urlsToCache = event.data.urls || [];

        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return Promise.all(urlsToCache.map(urlStr => {
                    const req = new Request(urlStr);
                    return cache.match(req).then(res => {
                        if (!res) {
                            console.log('[SW] Pre-caching in background:', urlStr);
                            return fetch(req).then(netRes => {
                                if (netRes && netRes.status === 200) {
                                    cache.put(req, netRes);
                                }
                            }).catch(err => console.log('[SW] Precache failed for', urlStr, err));
                        }
                    });
                }));
            })
        );
        return;
    }

    // Bulk playlist cache with progress reporting back to the requesting client
    if (event.data && event.data.action === 'cache_playlist') {
        const urls = event.data.urls || [];
        const cacheId = event.data.cacheId || 'default'; // unique per cache operation
        const total = urls.length;
        if (total === 0) return;

        const source = event.source;

        const notifyProgress = (url) => {
            if (source) {
                source.postMessage({ action: 'cache_progress', url, total, cacheId });
            }
        };

        const notifyDone = () => {
            if (source) {
                source.postMessage({ action: 'cache_done', total, cacheId });
            }
        };

        const BATCH = 3;

        const process = async () => {
            const cache = await caches.open(CACHE_NAME);
            for (let i = 0; i < urls.length; i += BATCH) {
                const batch = urls.slice(i, i + BATCH);
                await Promise.all(batch.map(async (urlStr) => {
                    const req = new Request(urlStr);
                    const existing = await cache.match(req);
                    if (existing) {
                        notifyProgress(urlStr);
                        return;
                    }
                    try {
                        const res = await fetch(req);
                        if (res && res.status === 200) {
                            await cache.put(req, res.clone());
                        }
                        notifyProgress(urlStr);
                    } catch (e) {
                        console.log('[SW] cache_playlist fetch failed:', urlStr, e);
                        notifyProgress(urlStr);
                    }
                }));
            }
            notifyDone();
        };

        event.waitUntil(process());
        return;
    }
});

const CACHE_NAME = 'syncmusic-cache-v1';

// Assets to cache on installation
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/src/styles/main.css',
    '/src/js/main.js',
    '/src/js/player.js',
    '/src/js/websocket.js',
    '/src/js/api.js'
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

    // Audio files /music/ logic - Network First with Fallback to Cache
    // If we're offiline, look in the cache. 
    // We want the browser to natively stream it or use Range requests, so caching huge files via Service Worker
    // needs to act like a proxy.
    if (url.pathname.startsWith('/music/')) {
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                   console.log('[SW] Serving audio from cache:', url.pathname);
                   return cachedResponse;
                }
                
                // If not in cache, fetch and put in cache.
                return fetch(event.request).then((networkResponse) => {
                    // Only cache successful, complete responses (don't cache 206 partial content by default via basic block cache)
                    // Note: Caching whole audio files handles offline better than 206. 
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

    // Default API / other requests Cache First -> then Network
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request).then(netRes => {
                // Ignore API data caching to keep song list fresh (optional: can cache library API for total offline)
                if (url.pathname.startsWith('/api/')) {
                   return netRes;
                }

                if (!netRes || netRes.status !== 200 || netRes.type !== 'basic') {
                    return netRes;
                }
                const responseToCache = netRes.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
                return netRes;
            });
        })
    );
});


// Listen for messages from the client (e.g., to pre-cache next songs)
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'precache') {
        const urlsToCache = event.data.urls || [];
        
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return Promise.all(urlsToCache.map(urlStr => {
                    const req = new Request(urlStr);
                    return cache.match(req).then(res => {
                        if (!res) {
                            console.log('[SW] Pre-caching in background:', urlStr);
                            // Fetch whole file without CORS mode restrictions causing issues for same-origin
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
    }
});

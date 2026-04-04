import { Utils } from './ui.js';

export const CacheManager = {
    stateMap: new Map(),

    initSWListener: () => {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                if (!data || !data.cacheId) return;

                const state = CacheManager.stateMap.get(data.cacheId);
                if (!state) return;

                if (data.action === 'cache_progress') {
                    state.done++;
                    // Each song = 2 URLs (audio + cover). Show song count to the user.
                    const songsProcessed = Math.floor(state.done / 2);
                    const pct = Math.round((state.done / data.total) * 100);

                    if (state.fillEl) state.fillEl.style.width = pct + '%';
                    if (state.labelEl) state.labelEl.textContent = `${songsProcessed} / ${state.songCount} songs`;

                    // Mark badge when the audio URL completes (not cover)
                    if (data.url) {
                        const u = new URL(data.url, window.location.origin);
                        if (u.pathname.startsWith('/music/')) {
                            const songPath = decodeURIComponent(u.pathname.slice('/music/'.length));
                            const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(songPath)}"]`);
                            if (badge) { badge.classList.remove('caching'); badge.classList.add('cached'); badge.textContent = '✓'; }
                        }
                    }
                }

                if (data.action === 'cache_done') {
                    if (state.fillEl) state.fillEl.style.width = '100%';
                    if (state.labelEl) state.labelEl.textContent = `${state.songCount} / ${state.songCount} songs`;
                    if (state.btn) {
                        state.btn.disabled = true;
                        state.btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Cached (~${Utils.formatBytes(state.totalSize)})`;
                    }
                    CacheManager.stateMap.delete(data.cacheId);
                }
            });
        }
    },

    checkCacheStatus: async (songs, cacheBtn, totalSize) => {
        if (!('caches' in window)) return;
        try {
            // Find the active SW cache (name may change with versions)
            const cacheNames = await caches.keys();
            const activeName = cacheNames.find(n => n.startsWith('syncmusic-cache-')) || null;
            if (!activeName) return;
            const cache = await caches.open(activeName);
            const keys = await cache.keys();
            const cachedPaths = new Set(keys.map(r => {
                const u = new URL(r.url);
                if (u.pathname.startsWith('/music/')) {
                    return decodeURIComponent(u.pathname.slice('/music/'.length));
                }
                if (u.pathname.startsWith('/api/cover')) {
                    // Also track covers so we know they are cached
                    return u.searchParams.get('song');
                }
                return null;
            }).filter(Boolean));
            let cachedCount = 0;
            songs.forEach(s => {
                // If the path exists in cachedPaths, it means BOTH the song and the cover were requested,
                // but checking the audio path is the primary indicator.
                const isCached = cachedPaths.has(s.path) || cachedPaths.has(Utils.encodePath(s.path));
                if (isCached) {
                    cachedCount++;
                    const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(s.path)}"]`);
                    if (badge) { badge.classList.remove('caching'); badge.classList.add('cached'); badge.textContent = '✓'; }
                }
            });
            // If every song is already cached, reflect that on the button
            if (cacheBtn && cachedCount === songs.length && songs.length > 0) {
                cacheBtn.disabled = true;
                cacheBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Cached (~${Utils.formatBytes(totalSize)})`;
            }
        } catch (e) { /* caches API unavailable */ }
    }
};

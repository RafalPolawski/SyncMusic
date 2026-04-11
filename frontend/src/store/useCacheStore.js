import { create } from 'zustand';

export const useCacheStore = create((set, get) => ({
    cachedPaths: new Set(),
    activeJobs: new Map(), // jobId -> { processed, total, songs }
    totalCacheSize: 0,
    isListening: false,

    // Actions
    initCacheListener: () => {
        if (get().isListening || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
        
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || !data.action) return;

            if (data.action === 'cache_progress') {
                const { cacheId, total, url } = data;
                set((state) => {
                    const jobs = new Map(state.activeJobs);
                    const job = jobs.get(cacheId) || { processed: 0, total, songs: [] };
                    job.processed++;
                    job.total = total; 
                    jobs.set(cacheId, job);
                    
                    // Add to cached paths
                    const newCached = new Set(state.cachedPaths);
                    if (url) {
                        try {
                            const u = new URL(url, window.location.origin);
                            if (u.pathname.startsWith('/music/')) {
                                const songPath = decodeURIComponent(u.pathname.slice('/music/'.length));
                                newCached.add(songPath);
                            }
                        } catch (e) {}
                    }
                    return { activeJobs: jobs, cachedPaths: newCached };
                });
                // Recalculate size occasionally?
                if (Math.random() > 0.9) get().updateSize();
            }

            if (data.action === 'cache_done') {
                const { cacheId } = data;
                set((state) => {
                    const jobs = new Map(state.activeJobs);
                    jobs.delete(cacheId);
                    return { activeJobs: jobs };
                });
                get().updateSize();
                get().checkCaches(); // Refresh all known paths
            }
        });

        set({ isListening: true });
        get().updateSize();
        get().checkCaches();
    },

    updateSize: async () => {
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
            const { usage } = await navigator.storage.estimate();
            set({ totalCacheSize: usage || 0 });
        }
    },

    checkCaches: async () => {
        if (typeof caches === 'undefined') return;
        try {
            const names = await caches.keys();
            const activeName = names.find(n => n.startsWith('syncmusic-cache-'));
            if (!activeName) return;
            const cache = await caches.open(activeName);
            const keys = await cache.keys();
            const paths = new Set();
            keys.forEach(r => {
                const u = new URL(r.url);
                if (u.pathname.startsWith('/music/')) {
                    paths.add(decodeURIComponent(u.pathname.slice('/music/'.length)));
                }
            });
            set({ cachedPaths: paths });
        } catch (e) {}
    },

    cacheSongs: (songs, jobId = 'manual') => {
        if (!navigator.serviceWorker?.controller) return;
        
        const urls = [];
        songs.forEach(s => {
            urls.push(`/music/${encodeURIComponent(s.path)}`);
            urls.push(`/api/cover?song=${encodeURIComponent(s.path)}`);
        });

        // Initialize progress in state locally too
        set(state => {
            const jobs = new Map(state.activeJobs);
            jobs.set(jobId, { processed: 0, total: urls.length, songs });
            return { activeJobs: jobs };
        });

        navigator.serviceWorker.controller.postMessage({
            action: 'cache_playlist',
            urls,
            cacheId: jobId
        });
    },

    clearCache: async () => {
        if (typeof caches === 'undefined') return;
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
        set({ cachedPaths: new Set(), totalCacheSize: 0 });
    }
}));

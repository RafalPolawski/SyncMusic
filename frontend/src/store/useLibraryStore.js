import { create } from 'zustand';

export const useLibraryStore = create((set, get) => ({
    songs: [],
    groups: {},
    isScanning: false,
    scanProgress: 0,
    scanTotal: 0,
    isLoading: true,
    error: null,

    fetchLibrary: async () => {
        set({ isLoading: true, error: null });
        const poll = async (delay = 1000) => {
            try {
                const res = await fetch('/api/songs');
                if (!res.ok) throw new Error('Failed to fetch songs');
                
                const data = await res.json();
                
                if (data.is_scanning) {
                    set({ 
                        isScanning: true, 
                        scanProgress: data.scan_current || 0, 
                        scanTotal: data.scan_total || 1 
                    });
                    setTimeout(() => poll(1000), 1000);
                    return;
                }

                if (!Array.isArray(data)) {
                    setTimeout(() => poll(1000), 1000);
                    return;
                }

                const groups = {};
                data.forEach(song => {
                    const folder = song.path.includes('/') ? song.path.split('/')[0] : 'Loose Tracks';
                    if (!groups[folder]) groups[folder] = [];
                    groups[folder].push(song);
                });

                set({ songs: data, groups, isScanning: false, isLoading: false });
            } catch (err) {
                console.error(err);
                setTimeout(() => poll(Math.min(delay * 2, 8000)), delay);
            }
        };
        poll();
    },

    rescanLibrary: async () => {
        try {
            await fetch('/api/rescan');
            set({ isScanning: true, isLoading: true });
            setTimeout(() => get().fetchLibrary(), 500); // 500ms delay to let backend set is_scanning flag
        } catch (e) {
            console.error("Rescan failed", e);
        }
    }
}));

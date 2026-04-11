import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const usePlayerStore = create(
    persist(
        (set, get) => ({
            // Current Track Data
            currentPath: null,
            currentFolder: null,
            title: 'Select a Track',
            artist: 'SyncMusic',
            coverUrl: null,
            
            // Playback State
            isPlaying: false,
            volume: 1.0,
            isMuted: false,
            currentTime: 0,
            duration: 0,
            
            // Sync specific
            syncReceivedTime: 0,
            syncAudioTime: 0,
            syncEnabled: true,
            syncThreshold: 3.0,

            // Modes
            isShuffle: false,
            isRepeat: 0, // 0=off, 1=playlist, 2=track
            offlineMode: false,
            roomId: null,

            // Actions
            setTrack: (path, folder, title, artist) => set({
                currentPath: path,
                currentFolder: folder,
                title: title || 'Unknown Title',
                artist: artist || 'Unknown Artist',
                coverUrl: path ? `/api/cover?song=${encodeURIComponent(path)}` : null
            }),
            setPlaying: (isPlaying) => set({ isPlaying }),
            setVolume: (volume) => set({ volume, isMuted: volume === 0 }),
            setProgress: (currentTime, duration) => set({ currentTime, duration }),
            setSyncSettings: (syncEnabled, syncThreshold) => set({ syncEnabled, syncThreshold }),
            setModes: (isShuffle, isRepeat) => set({ isShuffle, isRepeat }),
            setRoom: (roomId) => set({ roomId }),
            setOffline: (offlineMode) => set({ offlineMode }),
        }),
        {
            name: 'syncmusic-player-storage',
            partialize: (state) => ({ 
                volume: state.volume, 
                syncEnabled: state.syncEnabled, 
                syncThreshold: state.syncThreshold,
                currentPath: state.currentPath,
                currentFolder: state.currentFolder
            }),
        }
    )
);

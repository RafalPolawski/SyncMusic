import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const usePlayerStore = create(
    persist(
        (set, get) => ({
            // Current Track Data
            currentPath: null,
            currentFolder: null, // Metadata folder of the song
            playbackContextFolder: null, // The folder/playlist context we are playing from
            playbackContextPath: null, // The last song played from the context (used for resumption)
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
            drift: 0,
            lastActionTimestamp: 0,
            shuffledQueue: [],

            // Actions
            setDrift: (drift) => set({ drift }),
            setTrack: (path, folder, title, artist, updateContext = false) => set((state) => ({
                currentPath: path,
                currentFolder: folder,
                playbackContextFolder: updateContext ? folder : state.playbackContextFolder,
                title: title || 'Unknown Title',
                artist: artist || 'Unknown Artist',
                coverUrl: path ? `/api/cover?song=${encodeURIComponent(path)}` : null
            })),
            setPlaying: (isPlaying) => set({ isPlaying }),
            setVolume: (volume) => set({ volume, isMuted: volume === 0 }),
            setProgress: (currentTime, duration) => set({ currentTime, duration }),
            setSyncSettings: (syncEnabled, syncThreshold) => set({ syncEnabled, syncThreshold }),
            setModes: (isShuffle, isRepeat) => set({ isShuffle, isRepeat }),
            setRoom: (roomId) => set({ roomId }),
            setOffline: (offlineMode) => set({ offlineMode }),
            setLastAction: () => set({ lastActionTimestamp: Date.now() }),
            setShuffledQueue: (shuffledQueue) => set({ shuffledQueue }),
        }),
        {
            name: 'syncmusic-player-storage',
            partialize: (state) => ({ 
                volume: state.volume, 
                syncEnabled: state.syncEnabled, 
                syncThreshold: state.syncThreshold,
                currentPath: state.currentPath,
                currentFolder: state.currentFolder,
                playbackContextFolder: state.playbackContextFolder,
                playbackContextPath: state.playbackContextPath
            }),
        }
    )
);

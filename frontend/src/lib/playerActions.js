import { usePlayerStore } from '../store/usePlayerStore';
import { useQueueStore } from '../store/useQueueStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { socket } from './webtransport';

/**
 * Generates a random sequence for a folder and returns it.
 * This should be used to seed the server's shared sequence.
 * @param {string} folderName - The name of the folder to shuffle.
 * @param {string} startPath - Optional track path that should be moved to the beginning of the shuffle.
 */
export const generateSharedShuffle = (folderName, startPath = null) => {
    const { groups } = useLibraryStore.getState();
    const tracks = groups[folderName] || [];
    if (tracks.length === 0) return [];
    
    let pool = [...tracks].map(s => ({ ...s, __folder: folderName }));
    let result = [];

    // Prioritize startPath or the last known context path to anchor the shuffle
    const anchorPath = startPath || usePlayerStore.getState().playbackContextPath;
    
    if (anchorPath) {
        const anchorIdx = pool.findIndex(s => s.path === anchorPath);
        if (anchorIdx !== -1) {
            result.push(pool[anchorIdx]);
            pool.splice(anchorIdx, 1);
        }
    }

    // Shuffle remaining tracks
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    return [...result, ...pool];
};

export const playNext = () => {
    const nextInQueue = useQueueStore.getState().nextTrack();
    if (nextInQueue) {
        socket.sendCommand('load', { 
            song: nextInQueue.path, 
            folder: nextInQueue.folder, 
            title: nextInQueue.title, 
            artist: nextInQueue.artist,
            is_queue: true 
        });
        return;
    }

    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, playbackContextPath, isRepeat, isShuffle, shuffledQueue } = player;
    const { groups } = useLibraryStore.getState();
    
    const activeFolder = playbackContextFolder;
    if (!activeFolder || !groups[activeFolder]) return;

    const fullPlaylist = groups[activeFolder];
    const source = isShuffle ? (shuffledQueue.length > 0 ? shuffledQueue : fullPlaylist) : fullPlaylist;
    
    // We attempt to find our position in the sequence using multiple fallback steps:
    // 1. Current song path (best case)
    // 2. The 'pivot' anchor (last known good context song)
    // 3. Fallback to start or loop
    const idx = source.findIndex(s => s.path === currentPath);
    let effectiveIdx = idx;
    
    if (idx === -1 && playbackContextPath) {
        effectiveIdx = source.findIndex(s => s.path === playbackContextPath);
    }

    let nextTrack = null;
    if (effectiveIdx >= 0 && effectiveIdx < source.length - 1) {
        nextTrack = source[effectiveIdx + 1];
    } else if (effectiveIdx === -1 && source.length > 0) {
        // We aren't in the sequence at all (e.g. queue just finished)
        // Just play the first track in the sequence as a safety resume
        nextTrack = source[0];
    } else if (isRepeat === 1) { // Repeat Playlist
        nextTrack = source[0];
    }

    if (nextTrack) {
        socket.sendCommand('load', { 
            song: nextTrack.path, 
            folder: activeFolder, 
            title: nextTrack.title, 
            artist: nextTrack.artist,
            is_queue: false 
        });
    }
};

export const playPrev = () => {
    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, playbackContextPath, currentTime, isShuffle, shuffledQueue } = player;
    
    if (currentTime > 3) {
        socket.sendCommand('seek', { time: 0 });
        return;
    }

    const { groups } = useLibraryStore.getState();
    const activeFolder = playbackContextFolder;
    if (!activeFolder || !groups[activeFolder]) {
        socket.sendCommand('seek', { time: 0 });
        return;
    }

    const fullPlaylist = groups[activeFolder];
    const source = isShuffle ? (shuffledQueue.length > 0 ? shuffledQueue : fullPlaylist) : fullPlaylist;
    
    let effectiveIdx = source.findIndex(s => s.path === currentPath);
    if (effectiveIdx === -1 && playbackContextPath) {
        effectiveIdx = source.findIndex(s => s.path === playbackContextPath);
    }

    if (effectiveIdx > 0) {
        const prevTrack = source[effectiveIdx - 1];
        socket.sendCommand('load', { 
            song: prevTrack.path, 
            folder: activeFolder, 
            title: prevTrack.title, 
            artist: prevTrack.artist,
            is_queue: false 
        });
    } else {
        socket.sendCommand('seek', { time: 0 });
    }
};

export const skipTime = (delta) => {
    const { currentTime, duration } = usePlayerStore.getState();
    let target = currentTime + delta;
    if (target < 0) target = 0;
    if (target > duration) target = duration;
    socket.sendCommand('seek', { time: target });
};

export const toggleShuffleAction = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    
    const { isShuffle, playbackContextFolder, currentPath } = usePlayerStore.getState();
    const newShuffle = !isShuffle;
    const payload = { state: newShuffle };
    
    if (newShuffle && playbackContextFolder) {
        payload.shuffled_sequence = generateSharedShuffle(playbackContextFolder, currentPath);
    }
    
    usePlayerStore.setState({ isShuffle: newShuffle });
    socket.sendCommand('shuffle', { ...payload, is_queue: false });
};

export const toggleRepeatAction = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    
    const { isRepeat, isShuffle } = usePlayerStore.getState();
    const newRepeat = (isRepeat + 1) % 3;
    
    usePlayerStore.setState({ isRepeat: newRepeat });
    socket.sendCommand('repeat', { state: newRepeat });
};

export const getUpcomingTracks = (limit = 1000) => {
    const queue = useQueueStore.getState().queue;
    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, playbackContextPath, isShuffle, shuffledQueue, isRepeat } = player;
    const { groups } = useLibraryStore.getState();
    
    let upcoming = [...queue];
    const activeFolder = playbackContextFolder;

    if (activeFolder && groups[activeFolder]) {
        const fullPlaylist = groups[activeFolder];
        const source = (isShuffle && shuffledQueue.length > 0) ? shuffledQueue : fullPlaylist;
        
        let idx = source.findIndex(s => s.path === currentPath);
        if (idx === -1 && playbackContextPath) {
            idx = source.findIndex(s => s.path === playbackContextPath);
        }

        if (idx >= 0) {
            let nextInFolder = source.slice(idx + 1);
            if (isRepeat === 1) { // Repeat Playlist
                nextInFolder = [...nextInFolder, ...source.slice(0, idx)];
            }
            upcoming = [...upcoming, ...nextInFolder];
        } else {
            // If completely lost, show the whole sequence
            upcoming = [...upcoming, ...source];
        }
    }
    
    return upcoming.slice(0, limit);
};

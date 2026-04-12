import { usePlayerStore } from '../store/usePlayerStore';
import { useQueueStore } from '../store/useQueueStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { socket } from './webtransport';

export const playNext = () => {
    const nextInQueue = useQueueStore.getState().nextTrack();
    if (nextInQueue) {
        // When playing from queue, we DON'T update the context folder.
        // The server will echo 'load', and our WT handler will see it's from queue.
        socket.sendCommand('load', { song: nextInQueue.path, folder: nextInQueue.folder, title: nextInQueue.title, artist: nextInQueue.artist });
        return;
    }

    // Fallback to library folder context
    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, isRepeat, isShuffle, shuffledQueue } = player;
    const { groups } = useLibraryStore.getState();
    
    // Always use playbackContextFolder for the automatic sequence
    const activeFolder = playbackContextFolder;

    if (activeFolder && groups[activeFolder]) {
        const fullPlaylist = groups[activeFolder];
        
        let nextTrack = null;
        if (isShuffle) {
            let workingQueue = shuffledQueue;
            
            // Regeneration logic: 
            // 1. No queue exists
            // 2. Queue doesn't match active folder
            // 3. Queue size doesn't match the folder size (Bug fix for incomplete shuffles)
            const needsRegen = !workingQueue || 
                               workingQueue.length === 0 || 
                               workingQueue[0]?.__folder !== activeFolder ||
                               workingQueue.length !== fullPlaylist.length;

            if (needsRegen) {
                console.log(`[Shuffle] Regenerating full sequence for ${activeFolder} (${fullPlaylist.length} tracks)`);
                workingQueue = [...fullPlaylist]
                    .map(s => ({ ...s, __folder: activeFolder }))
                    .sort(() => Math.random() - 0.5);
                usePlayerStore.setState({ shuffledQueue: workingQueue });
            }
            
            const idx = workingQueue.findIndex(s => s.path === currentPath);
            if (idx >= 0 && idx < workingQueue.length - 1) {
                nextTrack = workingQueue[idx + 1];
            } else if (isRepeat === 1) { // Repeat Playlist
                nextTrack = workingQueue[0];
            }
        } else {
            const idx = fullPlaylist.findIndex(s => s.path === currentPath);
            if (idx >= 0 && idx < fullPlaylist.length - 1) {
                nextTrack = fullPlaylist[idx + 1];
            } else if (isRepeat === 1) { // Repeat Playlist
                nextTrack = fullPlaylist[0];
            }
        }

        if (nextTrack) {
            socket.sendCommand('load', { song: nextTrack.path, folder: activeFolder, title: nextTrack.title, artist: nextTrack.artist });
        }
    }
};

export const playPrev = () => {
    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, currentTime, isShuffle, shuffledQueue } = player;
    
    if (currentTime > 3) {
        socket.sendCommand('seek', { time: 0 });
        return;
    }

    const { groups } = useLibraryStore.getState();
    const activeFolder = playbackContextFolder;

    if (activeFolder && groups[activeFolder]) {
        const fullPlaylist = groups[activeFolder];
        let prevTrack = null;

        if (isShuffle && shuffledQueue.length > 0) {
            const idx = shuffledQueue.findIndex(s => s.path === currentPath);
            if (idx > 0) {
                prevTrack = shuffledQueue[idx - 1];
            }
        } else {
            const idx = fullPlaylist.findIndex(s => s.path === currentPath);
            if (idx > 0) {
                prevTrack = fullPlaylist[idx - 1];
            }
        }

        if (prevTrack) {
            socket.sendCommand('load', { song: prevTrack.path, folder: activeFolder, title: prevTrack.title, artist: prevTrack.artist });
        } else {
            socket.sendCommand('seek', { time: 0 });
        }
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

/**
 * Returns the next N tracks in the current playback sequence.
 */
export const getUpcomingTracks = (limit = 1000) => {
    const queue = useQueueStore.getState().queue;
    const player = usePlayerStore.getState();
    const { currentPath, playbackContextFolder, isShuffle, shuffledQueue, isRepeat } = player;
    const { groups } = useLibraryStore.getState();
    
    let upcoming = [...queue];
    const activeFolder = playbackContextFolder;

    if (activeFolder && groups[activeFolder]) {
        const fullPlaylist = groups[activeFolder];
        
        // Use the shuffled queue if active, otherwise the standard list
        let source = fullPlaylist;
        if (isShuffle && shuffledQueue.length === fullPlaylist.length && shuffledQueue[0]?.__folder === activeFolder) {
            source = shuffledQueue;
        }
        
        const idx = source.findIndex(s => s.path === currentPath);
        if (idx >= 0) {
            let nextInFolder = source.slice(idx + 1);
            if (isRepeat === 1) { // Repeat Playlist
                nextInFolder = [...nextInFolder, ...source.slice(0, idx)];
            }
            upcoming = [...upcoming, ...nextInFolder];
        } else {
            // If current track is NOT in the active folder (e.g. from queue), 
            // the sequence continues with the whole folder sequence.
            upcoming = [...upcoming, ...source];
        }
    }
    
    return upcoming.slice(0, limit);
};

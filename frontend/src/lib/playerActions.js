import { usePlayerStore } from '../store/usePlayerStore';
import { useQueueStore } from '../store/useQueueStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { socket } from './webtransport';

export const playNext = () => {
    const nextInQueue = useQueueStore.getState().nextTrack();
    if (nextInQueue) {
        socket.sendCommand('load', { song: nextInQueue.path, folder: nextInQueue.folder, title: nextInQueue.title, artist: nextInQueue.artist });
        return;
    }

    // Fallback to library folder
    const { currentPath, currentFolder, isRepeat } = usePlayerStore.getState();
    const { groups } = useLibraryStore.getState();
    
    if (currentFolder && groups[currentFolder]) {
        const list = groups[currentFolder];
        const isShuffle = usePlayerStore.getState().isShuffle;
        
        let nextIdx = -1;
        if (isShuffle) {
            nextIdx = Math.floor(Math.random() * list.length);
        } else {
            const idx = list.findIndex(s => s.path === currentPath);
            if (idx >= 0) {
                nextIdx = idx + 1;
            }
        }

        if (nextIdx >= 0 && nextIdx < list.length) {
            const next = list[nextIdx];
            socket.sendCommand('load', { song: next.path, folder: currentFolder, title: next.title, artist: next.artist });
        } else if (isRepeat === 1 && list.length > 0) { // Repeat Playlist
            const next = list[0];
            socket.sendCommand('load', { song: next.path, folder: currentFolder, title: next.title, artist: next.artist });
        }
    }
};

export const playPrev = () => {
    const { currentPath, currentFolder, syncAudioTime } = usePlayerStore.getState();
    
    if (syncAudioTime > 3) {
        socket.sendCommand('seek', { time: 0 });
        return;
    }

    const { groups } = useLibraryStore.getState();
    if (currentFolder && groups[currentFolder]) {
        const list = groups[currentFolder];
        const idx = list.findIndex(s => s.path === currentPath);
        if (idx > 0) {
            const prev = list[idx - 1];
            socket.sendCommand('load', { song: prev.path, folder: currentFolder, title: prev.title, artist: prev.artist });
        } else {
            socket.sendCommand('seek', { time: 0 });
        }
    } else {
        socket.sendCommand('seek', { time: 0 });
    }
};

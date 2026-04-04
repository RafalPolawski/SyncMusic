/**
 * Player navigation: next/prev track, eager-load-and-play.
 */

import { Utils } from '../ui.js';

export function initNavigation(audio, state, socket, { updateNowPlaying, forcePlay }) {
    const handleEagerLoadAndPlay = (targetPath) => {
        state.pendingEagerPaths.push(targetPath);
        if (state.currentSongPath !== targetPath || !state.currentSongPath) {
            audio.src = '/music/' + Utils.encodePath(targetPath);
            audio.currentTime = 0; // Fixes random offset start
            state.currentSongPath = targetPath;
            updateNowPlaying(state.currentSongPath);
        }
        state.shouldBePlaying = true;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        forcePlay();
    };

    const playNext = (isNaturalEnd = false) => {
        if (navigator.vibrate) navigator.vibrate(30);
        if (state.isHandlingEnd) return;
        state.isHandlingEnd = true;
        setTimeout(() => { state.isHandlingEnd = false; }, 300);

        // Repeat-one: restart current track
        if (isNaturalEnd && state.isRepeat === 2) {
            socket.sendCommand('seek', { time: 0, isPlaying: true });
            audio.currentTime = 0;
            state.shouldBePlaying = true;
            forcePlay();
            return;
        }

        if (isNaturalEnd) state.forwardHistory = [];

        if (state.currentSongPath && state.isRepeat !== 2) {
            state.playedHistory.push(state.currentSongPath);
            if (state.playedHistory.length > state.MAX_HISTORY) state.playedHistory.shift();
        }

        // Queue takes priority
        if (state.globalQueue.length > 0) {
            const nextItem = state.globalQueue[0];
            socket.sendCommand('load', { song: nextItem.path, folder: 'Queue', expected_previous: state.currentSongPath });
            socket.sendCommand('dequeue', { id: nextItem.id });
            handleEagerLoadAndPlay(nextItem.path);
            return;
        }

        if (state.currentPlaylist.length === 0) return;

        let nextSongPath;
        if (state.isShuffle) {
            if (state.forwardHistory.length > 0) {
                nextSongPath = state.forwardHistory.pop();
            } else {
                if (state.shuffleQueue.length === 0) {
                    state.shuffleQueue = Array.from({ length: state.currentPlaylist.length }, (_, i) => i);
                    for (let i = state.shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [state.shuffleQueue[i], state.shuffleQueue[j]] = [state.shuffleQueue[j], state.shuffleQueue[i]];
                    }
                    // Avoid immediately repeating the current song after re-shuffle
                    const ci = state.currentPlaylist.findIndex(s => s.path === state.currentSongPath);
                    if (state.shuffleQueue[state.shuffleQueue.length - 1] === ci && state.currentPlaylist.length > 1) {
                        [state.shuffleQueue[state.shuffleQueue.length - 1], state.shuffleQueue[0]] =
                            [state.shuffleQueue[0], state.shuffleQueue[state.shuffleQueue.length - 1]];
                    }
                }
                nextSongPath = state.currentPlaylist[state.shuffleQueue.pop()].path;
            }
        } else {
            const searchPath = state.backgroundPlaylistPath || state.currentSongPath;
            const currentIndex = state.currentPlaylist.findIndex(s => s.path === searchPath);
            let nextIndex = currentIndex + 1;
            if (nextIndex >= state.currentPlaylist.length) {
                if (state.isRepeat === 0 && isNaturalEnd) {
                    socket.sendCommand('pause', { time: 0 });
                    return;
                }
                nextIndex = 0;
            }
            nextSongPath = state.currentPlaylist[nextIndex].path;
        }

        socket.sendCommand('load', { song: nextSongPath, folder: state.currentFolderName, expected_previous: state.currentSongPath });
        handleEagerLoadAndPlay(nextSongPath);
    };

    const playPrev = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        if (state.currentPlaylist.length === 0) return;

        // Spotify-style: if > 3s into track, seek to start
        if (audio.currentTime > 3) {
            socket.sendCommand('seek', { time: 0, isPlaying: state.shouldBePlaying });
            audio.currentTime = 0;
            return;
        }

        if (state.playedHistory.length > 0) {
            if (state.currentSongPath) {
                state.forwardHistory.push(state.currentSongPath);
                if (state.forwardHistory.length > state.MAX_HISTORY) state.forwardHistory.shift();
            }
            const prevSongPath = state.playedHistory.pop();
            socket.sendCommand('load', { song: prevSongPath, isPrev: true, folder: state.currentFolderName, expected_previous: state.currentSongPath });
            handleEagerLoadAndPlay(prevSongPath);
            return;
        }

        const searchPath = state.backgroundPlaylistPath || state.currentSongPath;
        const currentIndex = state.currentPlaylist.findIndex(s => s.path === searchPath);
        const prevIndex = currentIndex - 1 < 0 ? state.currentPlaylist.length - 1 : currentIndex - 1;
        const prevSongPath = state.currentPlaylist[prevIndex].path;
        socket.sendCommand('load', { song: prevSongPath, isPrev: true, folder: state.currentFolderName, expected_previous: state.currentSongPath });
        handleEagerLoadAndPlay(prevSongPath);
    };

    return { playNext, playPrev, handleEagerLoadAndPlay };
}

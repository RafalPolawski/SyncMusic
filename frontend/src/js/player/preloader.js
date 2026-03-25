/**
 * Next-track preloader.
 * Eagerly buffers upcoming audio so it starts instantly, even in background tabs.
 */

import { Utils } from '../ui.js';

const nextAudioPreloader = new Audio();
nextAudioPreloader.preload = 'auto';
nextAudioPreloader.muted = true;

export function precacheNextTracks(state) {
    if (state.currentPlaylist.length === 0) return;

    let nextUrl = null;

    if (state.globalQueue.length > 0) {
        nextUrl = `/music/${Utils.encodePath(state.globalQueue[0].path)}`;
    } else if (state.isShuffle && state.shuffleQueue.length > 0) {
        const idx = state.shuffleQueue[state.shuffleQueue.length - 1];
        nextUrl = `/music/${Utils.encodePath(state.currentPlaylist[idx].path)}`;
    } else {
        const searchPath = state.backgroundPlaylistPath || state.currentSongPath;
        const currentIndex = state.currentPlaylist.findIndex(s => s.path === searchPath);
        if (currentIndex !== -1) {
            const nextIndex = currentIndex + 1;
            if (nextIndex < state.currentPlaylist.length) {
                nextUrl = `/music/${Utils.encodePath(state.currentPlaylist[nextIndex].path)}`;
            } else if (state.isRepeat !== 0) {
                nextUrl = `/music/${Utils.encodePath(state.currentPlaylist[0].path)}`;
            }
        }
    }

    if (nextUrl) {
        const absoluteNextUrl = new URL(nextUrl, window.location.origin).href;
        if (nextAudioPreloader.src !== absoluteNextUrl) {
            nextAudioPreloader.src = absoluteNextUrl;
            // Force Android Chrome to buffer even when the tab is backgrounded.
            fetch(absoluteNextUrl, { headers: { Range: 'bytes=0-5000000' } }).catch(() => {});
        }
    }
}

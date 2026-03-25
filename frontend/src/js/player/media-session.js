/**
 * MediaSession API integration.
 * Handles position state updates, metadata display (cover art, title, artist),
 * and notification-bar media control action handlers.
 */

import { Utils } from '../ui.js';

export function initMediaSession(audio, dom, state, socket, navigators) {
    const { coverArt, trackTitle } = dom;

    const updatePositionState = () => {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            try {
                const duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
                const position = Math.max(0, Math.min(audio.currentTime || 0, duration));
                navigator.mediaSession.setPositionState({
                    duration,
                    playbackRate: audio.playbackRate || 1,
                    position,
                });
            } catch (e) {}
        }
    };

    const updateNowPlaying = (path) => {
        if (!path) return;

        let displayTitle = path.split('/').pop().replace(/\.[^/.]+$/, '');
        let displayArtist = 'Unknown Artist';

        for (const folder in state.allGroupsCache) {
            const found = state.allGroupsCache[folder].find(s => s.path === path);
            if (found) {
                displayTitle = found.title;
                displayArtist = found.artist;
                break;
            }
        }

        trackTitle.textContent = displayTitle;
        document.getElementById('trackArtist').textContent = displayArtist;

        const coverUrl = `/api/cover?song=${encodeURIComponent(path)}`;
        // Escape special characters for use inside CSS url()
        const safeCssUrl = coverUrl
            .replace(/'/g, '%27')
            .replace(/"/g, '%22')
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29');

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: displayTitle,
                artist: displayArtist,
                artwork: [{ src: new URL(coverUrl, window.location.origin).href, sizes: '512x512', type: 'image/jpeg' }],
            });
            navigator.mediaSession.playbackState = state.shouldBePlaying ? 'playing' : 'paused';
        }

        const img = new Image();
        img.onload = () => {
            coverArt.style.backgroundImage = `url('${safeCssUrl}')`;
            coverArt.style.backgroundSize = 'cover';
            coverArt.style.backgroundPosition = 'center';
            coverArt.innerHTML = '';
        };
        img.onerror = () => {
            coverArt.style.backgroundImage = 'linear-gradient(45deg, #2a2a2a, #3a3a3a)';
            coverArt.innerHTML = '🎵';
        };
        img.src = coverUrl;

        if (state.onTrackChangeCallback) {
            state.onTrackChangeCallback(path, state.currentFolderName);
        }

        if (navigators.precacheNextTracks) navigators.precacheNextTracks();
    };

    const registerActionHandlers = (playNext, playPrev) => {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.setActionHandler('play', () => {
            state.shouldBePlaying = true;
            audio.play();
            socket.sendCommand('play', { time: audio.currentTime });
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            state.shouldBePlaying = false;
            audio.pause();
            socket.sendCommand('pause', { time: audio.currentTime });
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
        navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
        navigator.mediaSession.setActionHandler('seekbackward', (d) => {
            const newTime = Math.max(audio.currentTime - (d.seekOffset || 10), 0);
            socket.sendCommand('seek', { time: newTime, isPlaying: state.shouldBePlaying });
        });
        navigator.mediaSession.setActionHandler('seekforward', (d) => {
            const newTime = Math.min(audio.currentTime + (d.seekOffset || 10), audio.duration || 0);
            socket.sendCommand('seek', { time: newTime, isPlaying: state.shouldBePlaying });
        });
        navigator.mediaSession.setActionHandler('seekto', (d) => {
            socket.sendCommand('seek', { time: d.seekTime, isPlaying: state.shouldBePlaying });
        });
    };

    return { updatePositionState, updateNowPlaying, registerActionHandlers };
}

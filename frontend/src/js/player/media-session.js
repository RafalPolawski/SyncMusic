/**
 * MediaSession API integration.
 * Handles position state updates, metadata, cover art, dominant color extraction.
 */

import { Utils } from '../ui.js';

// ── Dominant color extraction (Canvas-based, no dependencies) ─────────────────

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            default: h = ((r - g) / d + 4) / 6;
        }
    }
    return [h * 360, s * 100, l * 100];
}

function applyAlbumColor(imgEl) {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16; // downsample for speed
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgEl, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;

        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < d.length; i += 4) {
            const brightness = d[i] + d[i + 1] + d[i + 2];
            if (brightness < 30 || brightness > 700) continue; // skip near-black and near-white
            r += d[i]; g += d[i + 1]; b += d[i + 2]; count++;
        }
        if (count === 0) { resetAlbumColor(); return; }

        const [h, s, l] = rgbToHsl(
            Math.round(r / count),
            Math.round(g / count),
            Math.round(b / count)
        );
        // Boost saturation, darken for the gradient background
        const finalS = Math.min(s * 1.4, 85).toFixed(0);
        const finalL = Math.max(Math.min(l * 0.65, 38), 12).toFixed(0);

        const root = document.documentElement;
        root.style.setProperty('--album-h', Math.round(h));
        root.style.setProperty('--album-s', finalS + '%');
        root.style.setProperty('--album-l', finalL + '%');
    } catch (_) {
        resetAlbumColor();
    }
}

function resetAlbumColor() {
    const root = document.documentElement;
    root.style.removeProperty('--album-h');
    root.style.removeProperty('--album-s');
    root.style.removeProperty('--album-l');
}

// ── Marquee helper (Removed per user request) ───────────────────────────────

// ── Main module ───────────────────────────────────────────────────────────────

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

        let displayTitle  = path.split('/').pop().replace(/\.[^/.]+$/, '');
        let displayArtist = 'Unknown Artist';

        for (const folder in state.allGroupsCache) {
            const found = state.allGroupsCache[folder].find(s => s.path === path);
            if (found) {
                displayTitle  = found.title;
                displayArtist = found.artist;
                break;
            }
        }

        trackTitle.textContent = displayTitle;
        document.getElementById('trackArtist').textContent = displayArtist;

        const coverUrl    = `/api/cover?song=${encodeURIComponent(path)}`;
        const safeCssUrl  = coverUrl.replace(/'/g, '%27').replace(/"/g, '%22')
                                    .replace(/\(/g, '%28').replace(/\)/g, '%29');

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title:   displayTitle,
                artist:  displayArtist,
                artwork: [{ src: new URL(coverUrl, window.location.origin).href, sizes: '512x512', type: 'image/jpeg' }],
            });
            navigator.mediaSession.playbackState = state.shouldBePlaying ? 'playing' : 'paused';
        }

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            coverArt.style.backgroundImage    = `url('${safeCssUrl}')`;
            coverArt.style.backgroundSize     = 'cover';
            coverArt.style.backgroundPosition = 'center';
            coverArt.innerHTML = '';
            applyAlbumColor(img); // extract dominant color for gradient theming
        };
        img.onerror = () => {
            coverArt.style.backgroundImage = 'linear-gradient(45deg, #2a2a2a, #3a3a3a)';
            coverArt.innerHTML = '🎵';
            resetAlbumColor();
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

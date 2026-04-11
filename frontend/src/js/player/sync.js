/**
 * Server message handler (downstream sync).
 *
 * Drift correction strategy (adaptive, user-configurable):
 *   sync disabled  → no drift correction at all
 *   < threshold*5% → ignore (negligible)
 *   < threshold*50% → ±5% playbackRate (inaudible, gradual)
 *   < threshold     → ±10% playbackRate (aggressive but audible)
 *   >= threshold    → hard seek (jumps to exact server time)
 *
 * state.syncEnabled and state.syncHardSeekThreshold are user-adjustable
 * via Settings and persisted in localStorage.
 */

import { Utils } from '../ui.js';
import { updateShuffleUI, updateRepeatUI } from './controls.js';
import { savePlayerState } from './state.js';

export function initSync(audio, dom, state, socket, { forcePlay, updateNowPlaying, updatePositionState, precacheNextTracks }) {
    const { volumeSlider } = dom;

    // ── Clock offset helper ──────────────────────────────────────────────────

    /**
     * Given a server message, estimate the current correct playback position.
     * Uses server_ts (when server sent) + elapsed since then.
     */
    const withOffset = (msg) => {
        if (msg.server_ts && socket.getServerTime && msg.action !== 'pause') {
            const elapsed = (socket.getServerTime() - msg.server_ts) / 1000;
            return msg.time + Math.max(0, elapsed); // never go negative
        }
        return msg.time;
    };

    // ── Continuous drift correction loop ─────────────────────────────────────

    setInterval(() => {
        if (!state.hasJoined || !state.shouldBePlaying || audio.paused) {
            // Restore rate if paused externally
            if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
            return;
        }
        if (audio.readyState < 3) return; // Prevent fake drift accumulation while buffering
        if (!state.syncReceivedTime || !state.syncAudioTime) return;

        // Bug #3: respect user preference to disable sync entirely
        if (!state.syncEnabled) {
            if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
            return;
        }

        const elapsed = (Date.now() - state.syncReceivedTime) / 1000;
        const expectedTime = state.syncAudioTime + elapsed;
        const drift = audio.currentTime - expectedTime; // + = ahead, - = behind
        const absDrift = Math.abs(drift);

        const T = state.syncHardSeekThreshold; // user-configured threshold (seconds)

        if (absDrift < T * 0.05) {
            // Well within tolerance — snap back to perfect rate
            if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
        } else if (absDrift < T * 0.5) {
            // Mild drift — ±5% rate adjustment (inaudible, corrects slowly)
            audio.playbackRate = drift > 0 ? 0.95 : 1.05;
        } else if (absDrift < T) {
            // Significant drift — ±10% rate adjustment (may be barely perceptible)
            audio.playbackRate = drift > 0 ? 0.90 : 1.10;
        } else {
            // Large drift >= threshold — hard seek
            audio.currentTime = expectedTime;
            audio.playbackRate = 1.0;
        }
    }, 500);

    // ── Message dispatcher ───────────────────────────────────────────────────

    const handleSocketMessage = (msg) => {
        const offsetTime = withOffset(msg);

        switch (msg.action) {

            case 'sync': {
                if (msg.queue !== undefined) {
                    state.globalQueue = msg.queue || [];
                    if (state.onQueueUpdateCallback) state.onQueueUpdateCallback(state.globalQueue);
                }
                if (msg.folder) {
                    state.currentFolderName = msg.folder;
                    if (state.allGroupsCache[msg.folder]) {
                        state.currentPlaylist = state.allGroupsCache[msg.folder];
                    }
                }

                // ── Bug #2a: guard against stale server echo reverting eager skip ──
                // If the client has already skipped ahead, ignore a sync for an old song.
                if (state.pendingEagerPaths.length > 0 && msg.song && msg.song !== state.pendingEagerPaths[state.pendingEagerPaths.length - 1]) {
                    // Update timing state without changing src/UI
                    state.syncReceivedTime = Date.now();
                    state.syncAudioTime = offsetTime;
                    state.shouldBePlaying = msg.isPlaying;
                    if (msg.isShuffle !== undefined) { state.isShuffle = msg.isShuffle; updateShuffleUI(state, dom); }
                    if (msg.isRepeat !== undefined) { state.isRepeat = msg.isRepeat; updateRepeatUI(state, dom); }
                    if (msg.volume !== undefined) { audio.volume = msg.volume; volumeSlider.value = msg.volume; }
                    break;
                }

                const songChanged = state.currentSongPath !== msg.song;
                if (songChanged || !state.currentSongPath) {
                    audio.pause(); // Prevent audible pop (Bug #4) when sync causes src change
                    audio.src = '/music/' + Utils.encodePath(msg.song);
                    audio.currentTime = 0;
                    state.currentSongPath = msg.song;
                    savePlayerState(msg.song, msg.folder);
                    if (precacheNextTracks) precacheNextTracks();

                    // ── Bug #1: defer updateNowPlaying if library cache not yet loaded ──
                    if (Object.keys(state.allGroupsCache).length > 0) {
                        updateNowPlaying(state.currentSongPath);
                    } else {
                        state.pendingNowPlayingPath = msg.song;
                    }
                }

                // On initial sync — hard seek to exactly the right position
                audio.currentTime = offsetTime;

                state.syncReceivedTime = Date.now();
                state.syncAudioTime = offsetTime;
                state.shouldBePlaying = msg.isPlaying;
                if (state.shouldBePlaying) forcePlay();
                if (msg.isShuffle !== undefined) { state.isShuffle = msg.isShuffle; updateShuffleUI(state, dom); }
                if (msg.isRepeat !== undefined) { state.isRepeat = msg.isRepeat; updateRepeatUI(state, dom); }
                if (msg.volume !== undefined) {
                    audio.volume = msg.volume;
                    volumeSlider.value = msg.volume;
                }
                break;
            }

            case 'queue_update':
                state.globalQueue = msg.queue || [];
                if (state.onQueueUpdateCallback) state.onQueueUpdateCallback(state.globalQueue);
                break;

            case 'load': {
                if (msg.folder && state.allGroupsCache[msg.folder]) {
                    if (state.currentFolderName !== msg.folder) {
                        state.shuffleQueue = [];
                        state.forwardHistory = [];
                    }
                    state.currentFolderName = msg.folder;
                    state.currentPlaylist = state.allGroupsCache[msg.folder];
                    if (msg.folder !== 'Queue') state.backgroundPlaylistPath = msg.song;
                }

                // Prevent delayed server echoes from reverting rapid eager loads (Bug #2a)
                if (state.pendingEagerPaths.length > 0) {
                    const idx = state.pendingEagerPaths.lastIndexOf(msg.song);
                    if (idx !== -1) {
                        if (idx < state.pendingEagerPaths.length - 1) return;
                        state.pendingEagerPaths = [];
                    } else {
                        state.pendingEagerPaths = [];
                    }
                }

                if (!msg.isPrev && state.currentSongPath && state.currentSongPath !== msg.song) {
                    state.playedHistory.push(state.currentSongPath);
                    state.forwardHistory = [];
                } else if (msg.isPrev) {
                    if (state.playedHistory.length > 0 &&
                        state.playedHistory[state.playedHistory.length - 1] === msg.song) {
                        state.playedHistory.pop();
                    }
                }

                if (state.currentSongPath !== msg.song || !state.currentSongPath) {
                    audio.pause(); // Prevent pop (Bug #4)
                    audio.src = '/music/' + Utils.encodePath(msg.song);
                    audio.currentTime = 0;
                    state.currentSongPath = msg.song;
                    savePlayerState(msg.song, msg.folder);

                    // Bug #1: defer updateNowPlaying if cache not ready
                    if (Object.keys(state.allGroupsCache).length > 0) {
                        updateNowPlaying(state.currentSongPath);
                    } else {
                        state.pendingNowPlayingPath = msg.song;
                    }
                }
                state.syncReceivedTime = Date.now();
                state.syncAudioTime = 0;
                state.shouldBePlaying = true;
                audio.playbackRate = 1.0; // reset rate on new track
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                forcePlay();
                break;
            }

            case 'play': {
                const drift = Math.abs(audio.currentTime - offsetTime);
                // Only hard-seek if very large drift at play event — let continuous loop handle small
                if (state.hasJoined && drift > 2.0) {
                    audio.currentTime = offsetTime;
                    audio.playbackRate = 1.0;
                }
                state.shouldBePlaying = true;
                state.syncAudioTime = offsetTime;
                state.syncReceivedTime = Date.now();
                forcePlay();
                break;
            }

            case 'pause':
                state.shouldBePlaying = false;
                audio.playbackRate = 1.0; // always restore on pause
                if (state.hasJoined) { audio.pause(); audio.currentTime = msg.time; }
                state.syncAudioTime = msg.time;
                state.syncReceivedTime = Date.now();
                break;

            case 'seek':
                audio.playbackRate = 1.0;
                if (state.hasJoined) audio.currentTime = offsetTime;
                state.shouldBePlaying = msg.isPlaying === undefined ? true : msg.isPlaying;
                state.lastKnownTime = -1;
                state.syncAudioTime = offsetTime;
                state.syncReceivedTime = Date.now();
                updatePositionState();
                if (state.shouldBePlaying) forcePlay();
                break;

            case 'shuffle':
                state.isShuffle = msg.state;
                updateShuffleUI(state, dom);
                break;

            case 'repeat':
                state.isRepeat = msg.state;
                updateRepeatUI(state, dom);
                break;

            case 'volume':
                audio.volume = msg.level;
                volumeSlider.value = msg.level;
                break;

            default:
                break;
        }
    };

    // ── Join handler ─────────────────────────────────────────────────────────

    const handleJoinUserInit = () => {
        state.hasJoined = true;
        state.pendingPlay = false;

        let waitSeconds = state.shouldBePlaying ? (Date.now() - state.syncReceivedTime) / 1000 : 0;
        let targetTime = state.syncAudioTime + waitSeconds;

        if (audio.duration && targetTime >= audio.duration) {
            targetTime = Math.max(0, audio.duration - 0.5);
        }

        audio.currentTime = targetTime;
        audio.playbackRate = 1.0;
        if (state.shouldBePlaying) audio.play().catch((e) => console.error('Play error:', e));
    };

    /**
     * Unified load handler:
     *   - In Online mode: Sends a 'load' command to the server.
     *   - In Offline mode: Immediately triggers the 'load' logic locally.
     */
    const loadTrack = (path, folder) => {
        if (state.isOfflineMode) {
            handleSocketMessage({
                action: 'load',
                song: path,
                folder: folder,
                isPlaying: true
            });
        } else {
            socket.sendCommand('load', { song: path, folder: folder });
        }
    };

    return { handleSocketMessage, handleJoinUserInit, loadTrack };
}

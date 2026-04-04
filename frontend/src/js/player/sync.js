/**
 * Server message handler (downstream sync).
 *
 * Drift correction strategy (adaptive, based on drift magnitude):
 *   < 0.05s  → ignore (within human perception threshold)
 *   0.05–0.5s → ±2% playbackRate  (completely inaudible, corrects in ~25s)
 *   0.5–2.0s  → ±5% playbackRate  (barely perceptible, corrects in ~10s)
 *   > 2.0s    → hard seek          (necessary, happens rarely)
 *
 * The continuous drift loop runs every 500ms independently of server events,
 * so sync is maintained even between messages.
 */

import { Utils } from '../ui.js';
import { updateShuffleUI, updateRepeatUI } from './controls.js';
import { softSyncThreshold, savePlayerState } from './state.js';

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

        const elapsed = (Date.now() - state.syncReceivedTime) / 1000;
        const expectedTime = state.syncAudioTime + elapsed;
        const drift = audio.currentTime - expectedTime; // + = ahead, - = behind
        const absDrift = Math.abs(drift);

        if (absDrift < 0.015) {
            if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0; // snap back perfectly
        } else if (absDrift < 0.15) {
            // ±5% — fast correction without glitching (corrects 100ms in 2s)
            audio.playbackRate = drift > 0 ? 0.95 : 1.05;
        } else if (absDrift < 1.5) {
            // ±10% — aggressive correction
            audio.playbackRate = drift > 0 ? 0.90 : 1.10;
        } else {
            // Large drift — hard seek, snap playbackRate
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

                const songChanged = state.currentSongPath !== msg.song;
                if (songChanged || !state.currentSongPath) {
                    audio.src = '/music/' + Utils.encodePath(msg.song);
                    audio.currentTime = 0; // force explicit reset
                    state.currentSongPath = msg.song;
                    updateNowPlaying(state.currentSongPath);
                    savePlayerState(msg.song, msg.folder);
                    if (precacheNextTracks) precacheNextTracks();
                }

                // On initial sync — prefer hard seek to exactly the right position
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

                // Prevent delayed server echoes from reverting rapid eager loads
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
                    audio.src = '/music/' + Utils.encodePath(msg.song);
                    audio.currentTime = 0; // force explicit reset
                    state.currentSongPath = msg.song;
                    updateNowPlaying(state.currentSongPath);
                    savePlayerState(msg.song, msg.folder);
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

    return { handleSocketMessage, handleJoinUserInit };
}

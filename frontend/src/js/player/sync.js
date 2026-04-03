/**
 * Server message handler (downstream sync).
 * Applies server-authoritative state to the local audio element.
 */

import { Utils } from '../ui.js';
import { updateShuffleUI, updateRepeatUI } from './controls.js';
import { softSyncThreshold, savePlayerState } from './state.js';

export function initSync(audio, dom, state, socket, { forcePlay, updateNowPlaying, updatePositionState }) {
    const { volumeSlider } = dom;

    /**
     * Adjust a raw server timestamp to account for network latency.
     */
    const withOffset = (msg) => {
        if (msg.server_ts && socket.getServerTime && msg.action !== 'pause') {
            let elapsed = (socket.getServerTime() - msg.server_ts) / 1000;
            // Removed clamping since jitter is smoothed by EMA RTT
            return msg.time + elapsed;
        }
        return msg.time;
    };

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
                    state.currentSongPath = msg.song;
                    updateNowPlaying(state.currentSongPath);
                    savePlayerState(msg.song, msg.folder);
                }

                const drift = Math.abs(audio.currentTime - offsetTime);
                if (songChanged || drift > softSyncThreshold) {
                    audio.currentTime = offsetTime;
                }

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
                        if (idx < state.pendingEagerPaths.length - 1) return; // stale echo
                        state.pendingEagerPaths = [];
                    } else {
                        state.pendingEagerPaths = []; // authoritative override from another client
                    }
                }

                if (!msg.isPrev && state.currentSongPath && state.currentSongPath !== msg.song) {
                    state.playedHistory.push(state.currentSongPath);
                    state.forwardHistory = [];
                } else if (msg.isPrev) {
                    if (state.playedHistory.length > 0 && state.playedHistory[state.playedHistory.length - 1] === msg.song) {
                        state.playedHistory.pop();
                    }
                }

                if (state.currentSongPath !== msg.song || !state.currentSongPath) {
                    audio.src = '/music/' + Utils.encodePath(msg.song);
                    state.currentSongPath = msg.song;
                    updateNowPlaying(state.currentSongPath);
                    savePlayerState(msg.song, msg.folder);
                }
                state.shouldBePlaying = true;
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                forcePlay();
                break;
            }

            case 'play': {
                const drift = Math.abs(audio.currentTime - offsetTime);
                if (state.hasJoined && drift > softSyncThreshold) audio.currentTime = offsetTime;
                state.shouldBePlaying = true;
                state.syncAudioTime = offsetTime;
                state.syncReceivedTime = Date.now();
                forcePlay();
                break;
            }

            case 'pause':
                state.shouldBePlaying = false;
                if (state.hasJoined) { audio.pause(); audio.currentTime = msg.time; }
                state.syncAudioTime = msg.time;
                state.syncReceivedTime = Date.now();
                break;

            case 'seek':
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

    const handleJoinUserInit = () => {
        state.hasJoined = true;
        state.pendingPlay = false;

        let waitSeconds = state.shouldBePlaying ? (Date.now() - state.syncReceivedTime) / 1000 : 0;
        let targetTime = state.syncAudioTime + waitSeconds;

        // Clamp to avoid instantly firing onended due to network lag
        if (audio.duration && targetTime >= audio.duration) {
            targetTime = Math.max(0, audio.duration - 0.5);
        }

        audio.currentTime = targetTime;
        if (state.shouldBePlaying) audio.play().catch(e => console.error('Play error:', e));
    };

    return { handleSocketMessage, handleJoinUserInit };
}

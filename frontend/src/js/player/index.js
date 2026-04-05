/**
 * Player factory – assembles all sub-modules into the public player API.
 */

import { createState, loadPlayerState } from './state.js';
import { initMediaSession } from './media-session.js';
import { precacheNextTracks } from './preloader.js';
import { initControls, updateShuffleUI, updateRepeatUI } from './controls.js';
import { initNavigation } from './navigation.js';
import { initMobileUI } from './mobile-ui.js';
import { initSync } from './sync.js';

export { loadPlayerState };

export function initPlayer(socket) {
    // ── DOM references ────────────────────────────────────────────────────────
    const audio = document.getElementById('audioPlayer');
    const dom = {
        trackTitle:          document.getElementById('trackTitle'),
        playPauseBtn:        document.getElementById('playPauseBtn'),
        progressBar:         document.getElementById('progressBar'),
        currentTimeDisp:     document.getElementById('currentTimeDisp'),
        durationDisp:        document.getElementById('durationDisp'),
        coverArt:            document.getElementById('coverArt'),
        shuffleBtn:          document.getElementById('shuffleBtn'),
        volumeSlider:        document.getElementById('volumeSlider'),
        volumeIcon:          document.getElementById('volumeIcon'),
        overlay:             document.getElementById('overlay'),
        playerContainer:     document.getElementById('playerContainer'),
        miniPlayerClickZone: document.getElementById('miniPlayerClickZone'),
        playerToggleBtn:     document.getElementById('playerToggleBtn'),
        miniPlayPauseBtn:    document.getElementById('miniPlayPauseBtn'),
        miniNextBtn:         document.getElementById('miniNextBtn'),
        miniPrevBtn:         document.getElementById('miniPrevBtn'),
        miniShuffleBtn:      document.getElementById('miniShuffleBtn'),
        miniRepeatBtn:       document.getElementById('miniRepeatBtn'),
    };

    // ── Shared state ──────────────────────────────────────────────────────────
    const state = createState();

    // ── Restore last session from localStorage (works offline) ───────────────
    const restored = loadPlayerState();
    if (restored.lastPath) {
        state.currentSongPath = restored.lastPath;
        audio.src = '/music/' + restored.lastPath;
    }
    if (restored.lastFolder) {
        state.currentFolderName = restored.lastFolder;
    }

    // ── forcePlay helper (used by several modules) ─────────────────────────
    const forcePlay = () => {
        if (!state.hasJoined && !state.isOfflineMode) return;
        audio.play().catch((err) => {
            if (err.name === 'NotAllowedError' && !state.pendingPlay) {
                state.pendingPlay = true;
                dom.overlay.style.display = 'flex';
            }
        });
    };

    // ── MediaSession ──────────────────────────────────────────────────────────
    const mediaSession = initMediaSession(audio, dom, state, socket, {
        precacheNextTracks: () => precacheNextTracks(state),
    });

    // ── Navigation (needs forcePlay + updateNowPlaying) ───────────────────
    const navigation = initNavigation(audio, state, socket, {
        updateNowPlaying: mediaSession.updateNowPlaying,
        forcePlay,
    });

    // ── Register MediaSession action handlers (needs navigation) ───────────
    mediaSession.registerActionHandlers(navigation.playNext, navigation.playPrev);

    // ── Controls ──────────────────────────────────────────────────────────────
    initControls(audio, dom, state, socket, {
        updatePositionState: mediaSession.updatePositionState,
        updateShuffleUI: () => updateShuffleUI(state, dom),
        updateRepeatUI:  () => updateRepeatUI(state, dom),
        forcePlay,
        playNext: navigation.playNext,
        playPrev: navigation.playPrev,
    });

    // ── Mobile UI ─────────────────────────────────────────────────────────────
    initMobileUI(dom, { playNext: navigation.playNext, playPrev: navigation.playPrev });

    // ── Server sync ───────────────────────────────────────────────────────────
    const sync = initSync(audio, dom, state, socket, {
        forcePlay,
        updateNowPlaying:     mediaSession.updateNowPlaying,
        updatePositionState:  mediaSession.updatePositionState,
        precacheNextTracks:   () => precacheNextTracks(state),
    });

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        handleJoinUserInit: sync.handleJoinUserInit,
        handleSocketMessage: sync.handleSocketMessage,
        loadTrack:           sync.loadTrack,
        setOfflineStatus:    (e) => { state.isOfflineMode = e; },

        setCacheGroups: (groups) => {
            state.allGroupsCache = groups;
            if (state.currentFolderName && state.currentPlaylist.length === 0 && groups[state.currentFolderName]) {
                state.currentPlaylist = groups[state.currentFolderName];
                precacheNextTracks(state);
            }
        },

        setCurrentPlaylistFolder: (folder) => {
            if (state.currentFolderName !== folder) state.shuffleQueue = [];
            state.currentFolderName = folder;
            state.currentPlaylist = state.allGroupsCache[folder];
        },

        onTrackChanged:  (cb) => { state.onTrackChangeCallback = cb; },
        onQueueUpdate:   (cb) => { state.onQueueUpdateCallback = cb; },
        getQueue:        ()   => state.globalQueue,
        getCurrentState: ()   => ({ path: state.currentSongPath, folder: state.currentFolderName }),
    };
}

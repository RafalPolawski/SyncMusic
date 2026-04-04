/**
 * Player shared mutable state and sync threshold settings.
 * All player sub-modules receive this object by reference and mutate it directly.
 */



/** Persist key player state across page reloads */
export function savePlayerState(path, folder) {
    if (path) localStorage.setItem('syncMusicLastPath', path);
    if (folder) localStorage.setItem('syncMusicLastFolder', folder);
}

export function loadPlayerState() {
    return {
        lastPath:   localStorage.getItem('syncMusicLastPath'),
        lastFolder: localStorage.getItem('syncMusicLastFolder'),
    };
}

/**
 * Creates an initial player state bag shared across all sub-modules.
 */
export function createState() {
    return {
        // Sync / timing
        pendingPlay: false,
        syncReceivedTime: 0,
        syncAudioTime: 0,
        shouldBePlaying: false,
        hasJoined: false,
        lastKnownTime: -1,

        // Volume
        isMuted: false,
        volumeBeforeMute: 1,

        // Playlist / navigation
        currentPlaylist: [],
        currentSongPath: null,
        backgroundPlaylistPath: null, // original playlist pointer when playing from Queue
        currentFolderName: null,
        isShuffle: false,
        isRepeat: 0, // 0=off, 1=playlist, 2=track

        // History
        MAX_HISTORY: 100,
        playedHistory: [],
        forwardHistory: [],
        shuffleQueue: [],

        // Race-condition guards
        isHandlingEnd: false,
        isDraggingProgress: false,
        pendingEagerPaths: [],

        // Library cache (set by setCacheGroups)
        allGroupsCache: {},
        globalQueue: [],

        // Callbacks
        onTrackChangeCallback: null,
        onQueueUpdateCallback: null,
    };
}

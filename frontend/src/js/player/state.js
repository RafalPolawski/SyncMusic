/**
 * Player shared mutable state and sync threshold settings.
 * All player sub-modules receive this object by reference and mutate it directly.
 */

export let softSyncThreshold = parseFloat(localStorage.getItem('syncMusicThreshold')) || 3.0;

export function setSyncThreshold(val) {
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) {
        softSyncThreshold = parsed;
        localStorage.setItem('syncMusicThreshold', softSyncThreshold);
    }
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

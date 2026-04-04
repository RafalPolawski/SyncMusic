export const UI = {};

export const initUI = () => {
    Object.assign(UI, {
        nicknameInput: document.getElementById("nicknameInput"),
        roomIdInput: document.getElementById("roomIdInput"),
        joinBtn: document.getElementById("joinBtn"),
        offlineModeBtn: document.getElementById("offlineModeBtn"),
        foldersContainer: document.getElementById("foldersContainer"),
        songsContainer: document.getElementById("songsContainer"),
        backBtn: document.getElementById("backBtn"),
        loadingIndicator: document.getElementById("loadingIndicator"),
        settingsOverlay: document.getElementById("settingsOverlay"),
        openSettingsBtn: document.getElementById("openSettingsBtn"),
        closeSettingsBtn: document.getElementById("closeSettingsBtn"),
        syncThresholdInput: document.getElementById("syncThresholdInput"),
        settingsActionContainer: document.getElementById("settingsActionContainer"),
        locateTrackBtn: document.getElementById("locateTrackBtn"),
        navLibrary: document.getElementById("navLibrary"),
        navQueue: document.getElementById("navQueue"),
        libraryView: document.getElementById("libraryView"),
        queueView: document.getElementById("queueView"),
        queueContainer: document.getElementById("queueContainer"),
        queueCountBadge: document.getElementById("queueCountBadge"),
        overlay: document.getElementById("overlay"),
        appWrapper: document.getElementById("app-wrapper"),
        rttIndicator: document.getElementById('rttIndicator'),
        rttDot: document.getElementById('rttDot'),
        rttValue: document.getElementById('rttValue'),
        usersList: document.getElementById("usersList"),
        searchContainer: document.getElementById('searchContainer'),
        searchInput: document.getElementById('searchInput'),
        searchResults: document.getElementById('searchResults')
    });
};

export const Utils = {
    formatBytes: (bytes) => {
        if (!+bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    },
    encodePath: (path) => path.split('/').map(encodeURIComponent).join('/'),
    formatTime: (seconds) => {
        if (isNaN(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }
};

export const Icons = {
    fallbackCover: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='45' height='45'><rect width='45' height='45' fill='%23333'/><text x='50%' y='50%' font-size='20' text-anchor='middle' dominant-baseline='middle' fill='%23555'>🎵</text></svg>",
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
};

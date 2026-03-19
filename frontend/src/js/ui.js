export const UI = {};

export const initUI = () => {
    Object.assign(UI, {
        nicknameInput: document.getElementById("nicknameInput"),
        joinBtn: document.getElementById("joinBtn"),
        foldersContainer: document.getElementById("foldersContainer"),
        songsContainer: document.getElementById("songsContainer"),
        backBtn: document.getElementById("backBtn"),
        loadingIndicator: document.getElementById("loadingIndicator"),
        locateTrackBtn: document.getElementById("locateTrackBtn"),
        tabLibrary: document.getElementById("tabLibrary"),
        tabQueue: document.getElementById("tabQueue"),
        libraryView: document.getElementById("libraryView"),
        queueView: document.getElementById("queueView"),
        queueContainer: document.getElementById("queueContainer"),
        queueCountBadge: document.getElementById("queueCountBadge"),
        overlay: document.getElementById("overlay"),
        appWrapper: document.getElementById("app-wrapper"),
        rttIndicator: document.getElementById('rttIndicator'),
        rttDot: document.getElementById('rttDot'),
        rttValue: document.getElementById('rttValue'),
        usersList: document.getElementById("usersList")
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

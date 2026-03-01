/**
 * Player Initialization Module
 * 
 * Encapsulates all logic, state, and UI binding for the custom HTML5 Audio Player interface.
 * Implements strict, server-authoritative playback mapping (Server-Driven Execution),
 * preventing client-side race conditions when syncing across multiple devices.
 * 
 * @param {SyncWebSocket} socket - An initialized WebSocket interface to push action commands upstream.
 * @returns {Object} A set of closure functions hooked by the WebSocket listener to pipe state downstream.
 */
export function initPlayer(socket) {
    const audio = document.getElementById("audioPlayer");
    const trackTitle = document.getElementById("trackTitle");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const progressBar = document.getElementById("progressBar");
    const currentTimeDisp = document.getElementById("currentTimeDisp");
    const durationDisp = document.getElementById("durationDisp");
    const coverArt = document.getElementById("coverArt");
    const shuffleBtn = document.getElementById("shuffleBtn");
    const overlay = document.getElementById("overlay");

    let pendingPlay = false;
    let syncReceivedTime = 0;
    let syncAudioTime = 0;
    let shouldBePlaying = false;

    let currentPlaylist = [];
    let currentSongPath = "";
    let currentFolderName = "";
    let isShuffle = false;
    let isRepeat = 0; // 0 = off, 1 = playlist, 2 = track
    let lastKnownTime = -1;
    let isDraggingProgress = false;
    let playedHistory = [];
    let isHandlingEnd = false; // Anti-race condition

    let allGroupsCache = {};

    let onTrackChangeCallback = null;

    const svgPlay = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    const svgPause = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

    const formatTime = (seconds) => {
        if (isNaN(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    const updateNowPlaying = (path) => {
        if (!path) return;

        let displayTitle = path.split('/').pop().replace(/\.[^/.]+$/, "");
        let displayArtist = "Unknown Artist";

        // Reverse lookup over all groups to find the currently playing song's rich metadata
        for (const folder in allGroupsCache) {
            const foundNode = allGroupsCache[folder].find(s => s.path === path);
            if (foundNode) {
                displayTitle = foundNode.title;
                displayArtist = foundNode.artist;
                break;
            }
        }

        trackTitle.innerText = displayTitle;
        document.getElementById("trackArtist").innerText = displayArtist;

        const coverUrl = `/api/cover?song=${encodeURIComponent(path)}`;
        const safeCssUrl = coverUrl.replace(/'/g, "%27").replace(/"/g, "%22").replace(/\(/g, "%28").replace(/\)/g, "%29");

        const img = new Image();
        img.onload = () => {
            coverArt.style.backgroundImage = `url('${safeCssUrl}')`;
            coverArt.style.backgroundSize = "cover";
            coverArt.style.backgroundPosition = "center";
            coverArt.innerHTML = "";
        };
        img.onerror = () => {
            coverArt.style.backgroundImage = "linear-gradient(45deg, #2a2a2a, #3a3a3a)";
            coverArt.innerHTML = "🎵";
        };
        img.src = coverUrl;

        if (onTrackChangeCallback) {
            onTrackChangeCallback(path, currentFolderName);
        }
    };

    const updateShuffleUI = (state) => {
        isShuffle = state;
        document.getElementById("shuffleBtn").classList.toggle("active-green", isShuffle);
    };

    const updateRepeatUI = (state) => {
        isRepeat = state;
        const btn = document.getElementById("repeatBtn");
        btn.classList.toggle("active-green", isRepeat > 0);
        if (isRepeat === 0 || isRepeat === 1) {
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
        } else if (isRepeat === 2) {
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>';
        }
    };

    document.getElementById("shuffleBtn").onclick = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand("shuffle", { state: !isShuffle });
    };

    document.getElementById("repeatBtn").onclick = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand("repeat", { state: (isRepeat + 1) % 3 });
    };

    setInterval(() => {
        if (!shouldBePlaying) return;
        if (audio.readyState < 3) return;

        const isActuallyMoving = audio.currentTime > lastKnownTime;
        lastKnownTime = audio.currentTime;

        if (audio.paused || !isActuallyMoving) {
            audio.play().catch((err) => {
                if (err.name === 'NotAllowedError') {
                    if (!pendingPlay) {
                        pendingPlay = true;
                        overlay.style.display = "flex";
                    }
                }
            });
        }
    }, 800);

    audio.addEventListener('timeupdate', () => {
        if (!isDraggingProgress) progressBar.value = audio.currentTime;
        currentTimeDisp.innerText = formatTime(audio.currentTime);
        if (audio.duration) {
            progressBar.max = audio.duration;
            durationDisp.innerText = formatTime(audio.duration);
        }
    });

    audio.addEventListener('loadedmetadata', () => {
        progressBar.max = audio.duration;
        durationDisp.innerText = formatTime(audio.duration);
    });

    playPauseBtn.onclick = () => {
        if (navigator.vibrate) navigator.vibrate(50);
        socket.sendCommand(shouldBePlaying ? "pause" : "play", { time: audio.currentTime });
    };

    progressBar.addEventListener('input', () => {
        isDraggingProgress = true;
        currentTimeDisp.innerText = formatTime(progressBar.value);
    });

    progressBar.addEventListener('change', () => {
        isDraggingProgress = false;
        socket.sendCommand("seek", { time: parseFloat(progressBar.value), isPlaying: shouldBePlaying });
    });

    audio.onplay = () => {
        playPauseBtn.innerHTML = svgPause;
        coverArt.classList.add("playing");
    };

    audio.onpause = () => {
        playPauseBtn.innerHTML = svgPlay;
        coverArt.classList.remove("playing");
    };

    const playNext = (isNaturalEnd = false) => {
        if (navigator.vibrate) navigator.vibrate(30);
        if (currentPlaylist.length === 0) return;

        if (isNaturalEnd) {
            if (isHandlingEnd) return;
            isHandlingEnd = true;
            setTimeout(() => { isHandlingEnd = false; }, 2000);
        }

        if (isNaturalEnd && isRepeat === 2) {
            socket.sendCommand("seek", { time: 0, isPlaying: true });
            return;
        }

        if (currentSongPath && (!isNaturalEnd || isRepeat !== 2)) {
            playedHistory.push(currentSongPath);
        }

        let nextIndex = 0;
        if (isShuffle) {
            nextIndex = Math.floor(Math.random() * currentPlaylist.length);
        } else {
            const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
            nextIndex = currentIndex + 1;
            if (nextIndex >= currentPlaylist.length) {
                if (isRepeat === 0 && isNaturalEnd) {
                    socket.sendCommand("pause", { time: 0 });
                    return;
                }
                nextIndex = 0;
            }
        }
        socket.sendCommand("load", { song: currentPlaylist[nextIndex].path, folder: currentFolderName });
    };

    const playPrev = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        if (currentPlaylist.length === 0) return;

        if (playedHistory.length > 0) {
            const prevSongPath = playedHistory.pop();
            socket.sendCommand("load", { song: prevSongPath, isPrev: true, folder: currentFolderName });
            return;
        }

        const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
        let prevIndex = currentIndex - 1 < 0 ? currentPlaylist.length - 1 : currentIndex - 1;
        socket.sendCommand("load", { song: currentPlaylist[prevIndex].path, isPrev: true, folder: currentFolderName });
    };

    document.getElementById("nextBtn").onclick = () => playNext(false);
    document.getElementById("prevBtn").onclick = playPrev;
    audio.onended = () => { playNext(true); };

    document.getElementById("joinBtn").onclick = () => {
        overlay.style.display = "none";
        pendingPlay = false;
        const waitTimeSeconds = (Date.now() - syncReceivedTime) / 1000;
        audio.currentTime = syncAudioTime + waitTimeSeconds;
        shouldBePlaying = true;
        audio.play();
    };

    return {
        handleSocketMessage: (msg) => {
            if (msg.action === "sync") {
                if (msg.folder && allGroupsCache[msg.folder]) {
                    currentFolderName = msg.folder;
                    currentPlaylist = allGroupsCache[msg.folder];
                }
                audio.src = "/music/" + msg.song;
                currentSongPath = msg.song;
                updateNowPlaying(currentSongPath);
                audio.currentTime = msg.time;
                syncReceivedTime = Date.now();
                syncAudioTime = msg.time;
                shouldBePlaying = msg.isPlaying;
                if (msg.isShuffle !== undefined) updateShuffleUI(msg.isShuffle);
                if (msg.isRepeat !== undefined) updateRepeatUI(msg.isRepeat);

            } else if (msg.action === "load") {
                if (msg.folder && allGroupsCache[msg.folder]) {
                    currentFolderName = msg.folder;
                    currentPlaylist = allGroupsCache[msg.folder];
                }
                if (!msg.isPrev && currentSongPath && currentSongPath !== msg.song) {
                    playedHistory.push(currentSongPath);
                } else if (msg.isPrev) {
                    if (playedHistory.length > 0 && playedHistory[playedHistory.length - 1] === msg.song) playedHistory.pop();
                }
                audio.src = "/music/" + msg.song;
                currentSongPath = msg.song;
                updateNowPlaying(currentSongPath);
                shouldBePlaying = true;

            } else if (msg.action === "play") {
                audio.currentTime = msg.time;
                shouldBePlaying = true;
            } else if (msg.action === "pause") {
                shouldBePlaying = false;
                audio.pause();
                audio.currentTime = msg.time;
            } else if (msg.action === "seek") {
                audio.currentTime = msg.time;
                shouldBePlaying = msg.isPlaying === undefined ? true : msg.isPlaying;
                lastKnownTime = -1;
            } else if (msg.action === "shuffle") updateShuffleUI(msg.state);
            else if (msg.action === "repeat") updateRepeatUI(msg.state);
        },
        setCacheGroups: (groups) => allGroupsCache = groups,
        setCurrentPlaylistFolder: (folder) => { currentFolderName = folder; currentPlaylist = allGroupsCache[folder]; },
        onTrackChanged: (cb) => { onTrackChangeCallback = cb; },
        getCurrentState: () => ({ path: currentSongPath, folder: currentFolderName })
    };
}

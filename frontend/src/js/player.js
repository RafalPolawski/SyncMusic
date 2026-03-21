/**
 * Player Initialization Module
 * 
 * Encapsulates all logic, state, and UI binding for the custom HTML5 Audio Player interface.
 * Implements strict, server-authoritative playback mapping (Server-Driven Execution),
 * preventing client-side race conditions when syncing across multiple devices.
 * 
 * @param {SyncWebTransport} socket - An initialized WebTransport interface to push action commands upstream.
 * @returns {Object} A set of closure functions hooked by the WebTransport listener to pipe state downstream.
 */

import { Icons } from './ui.js';

export let softSyncThreshold = parseFloat(localStorage.getItem('syncMusicThreshold')) || 3.0;
export function setSyncThreshold(val) {
    let parsed = parseFloat(val);
    if (!isNaN(parsed)) {
        softSyncThreshold = parsed;
        localStorage.setItem('syncMusicThreshold', softSyncThreshold);
    }
}

export function initPlayer(socket) {
    const audio = document.getElementById("audioPlayer");
    const trackTitle = document.getElementById("trackTitle");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const progressBar = document.getElementById("progressBar");
    const currentTimeDisp = document.getElementById("currentTimeDisp");
    const durationDisp = document.getElementById("durationDisp");
    const coverArt = document.getElementById("coverArt");
    const shuffleBtn = document.getElementById("shuffleBtn");
    const volumeSlider = document.getElementById("volumeSlider");
    const volumeIcon = document.getElementById("volumeIcon");
    const overlay = document.getElementById("overlay");
    const playerContainer = document.getElementById("playerContainer");
    const miniPlayerClickZone = document.getElementById("miniPlayerClickZone");
    const playerToggleBtn = document.getElementById("playerToggleBtn");
    const miniPlayPauseBtn = document.getElementById("miniPlayPauseBtn");
    const miniNextBtn = document.getElementById("miniNextBtn");
    const miniPrevBtn = document.getElementById("miniPrevBtn");
    const miniShuffleBtn = document.getElementById("miniShuffleBtn");
    const miniRepeatBtn = document.getElementById("miniRepeatBtn");

    let pendingPlay = false;
    let syncReceivedTime = 0;
    let syncAudioTime = 0;
    let shouldBePlaying = false;
    let hasJoined = false;
    let isMuted = false;
    let volumeBeforeMute = 1;

    let currentPlaylist = [];
    let currentSongPath = null;
    let currentFolderName = null;
    let isShuffle = false;
    let isRepeat = 0; // 0 = off, 1 = playlist, 2 = track
    let lastKnownTime = -1;
    let isDraggingProgress = false;
    let playedHistory = [];
    let forwardHistory = []; // Tracks skipped-over songs so back→forward is deterministic
    let shuffleQueue = [];
    let isHandlingEnd = false; // Anti-race condition

    let allGroupsCache = {};
    let globalQueue = [];

    let onTrackChangeCallback = null;
    let onQueueUpdateCallback = null;

    // Restore saved volume from localStorage
    const savedVolume = parseFloat(localStorage.getItem("syncMusicVolume") ?? "1");
    audio.volume = savedVolume;
    volumeSlider.value = savedVolume;

    const formatTime = (seconds) => {
        if (isNaN(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

    const updatePositionState = () => {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            try {
                const duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
                const position = Math.max(0, Math.min(audio.currentTime || 0, duration));
                navigator.mediaSession.setPositionState({
                    duration: duration,
                    playbackRate: audio.playbackRate || 1,
                    position: position
                });
            } catch (e) {}
        }
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

        trackTitle.textContent = displayTitle;
        document.getElementById("trackArtist").textContent = displayArtist;

        const coverUrl = `/api/cover?song=${encodeURIComponent(path)}`;
        const safeCssUrl = coverUrl.replace(/'/g, "%27").replace(/"/g, "%22").replace(/\(/g, "%28").replace(/\)/g, "%29");

        const absoluteCoverUrl = new URL(coverUrl, window.location.origin).href;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: displayTitle,
                artist: displayArtist,
                artwork: [
                    { src: absoluteCoverUrl, sizes: '512x512', type: 'image/jpeg' }
                ]
            });
            navigator.mediaSession.playbackState = shouldBePlaying ? 'playing' : 'paused';
        }

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

        precacheNextTracks();
    };

    const MAX_HISTORY = 100;

    const precacheNextTracks = () => {
        if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
        if (currentPlaylist.length === 0) return;

        let urlsToCache = [];

        if (isShuffle) {
            // Buffer the actual upcoming tracks from the shuffle queue (peek, don't pop)
            const peekCount = Math.min(3, shuffleQueue.length);
            for (let i = 0; i < peekCount; i++) {
                const idx = shuffleQueue[shuffleQueue.length - 1 - i];
                urlsToCache.push(`/music/${encodePath(currentPlaylist[idx].path)}`);
            }
        } else {
            // Buffer the next 2 tracks linearly
            const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
            if (currentIndex !== -1) {
                for (let i = 1; i <= 2; i++) {
                    let nextIndex = currentIndex + i;
                    if (nextIndex < currentPlaylist.length) {
                        urlsToCache.push(`/music/${encodePath(currentPlaylist[nextIndex].path)}`);
                    } else if (isRepeat !== 0) { // wrap around if repeat is on
                        urlsToCache.push(`/music/${encodePath(currentPlaylist[nextIndex % currentPlaylist.length].path)}`);
                    }
                }
            }
        }

        if (urlsToCache.length > 0) {
            navigator.serviceWorker.controller.postMessage({
                action: 'precache',
                urls: urlsToCache
            });
        }
    };

    const updateShuffleUI = (state) => {
        isShuffle = state;
        document.getElementById("shuffleBtn").classList.toggle("active-green", isShuffle);
        miniShuffleBtn.classList.toggle("active-green", isShuffle);
    };

    const updateRepeatUI = (state) => {
        isRepeat = state;
        const btn = document.getElementById("repeatBtn");
        btn.classList.toggle("active-green", isRepeat > 0);
        miniRepeatBtn.classList.toggle("active-green", isRepeat > 0);

        let repeatIconHtml = '';
        if (isRepeat === 0 || isRepeat === 1) {
            repeatIconHtml = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
        } else if (isRepeat === 2) {
            repeatIconHtml = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>';
        }
        btn.innerHTML = repeatIconHtml;
        miniRepeatBtn.innerHTML = repeatIconHtml;
    };

    const toggleShuffle = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand("shuffle", { state: !isShuffle });
    };

    const toggleRepeat = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand("repeat", { state: (isRepeat + 1) % 3 });
    };

    document.getElementById("shuffleBtn").onclick = toggleShuffle;
    miniShuffleBtn.onclick = toggleShuffle;

    document.getElementById("repeatBtn").onclick = toggleRepeat;
    miniRepeatBtn.onclick = toggleRepeat;

    // Mobile Player Expand / Collapse Logic
    let isExpanded = false;

    const collapsePlayer = () => {
        if (isExpanded) {
            isExpanded = false;
            playerContainer.classList.remove("player-expanded");
        }
    };

    const expandPlayer = () => {
        // Only expand if we are on a mobile-sized screen
        if (!isExpanded && window.innerWidth < 1024) {
            isExpanded = true;
            playerContainer.classList.add("player-expanded");
            // Push a history state so device back button closes it
            history.pushState({ playerOpen: true }, "");
        }
    };

    miniPlayerClickZone.onclick = (e) => {
        // Prevent expansion if clicking on mini controls
        if (e.target.closest('#miniControls')) return;
        expandPlayer();
    };

    playerToggleBtn.onclick = (e) => {
        e.stopPropagation();
        if (isExpanded) {
            history.back(); // Trigger popstate
        }
    };

    window.addEventListener('popstate', () => {
        collapsePlayer();
    });

    // Touch gesture: Pull down to close
    let touchStartY = 0;
    playerContainer.addEventListener('touchstart', (e) => {
        touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    playerContainer.addEventListener('touchend', (e) => {
        if (!isExpanded) return;
        // Ignore pull down if user is interacting with the progress bar
        if (e.target === progressBar) return;

        const touchEndY = e.changedTouches[0].screenY;
        if (touchEndY - touchStartY > 80) { // 80px swipe down threshold
            if (isExpanded) {
                history.back();
            }
        }
    }, { passive: true });

    const forcePlay = () => {
        if (!hasJoined) return;
        audio.play().catch((err) => {
            if (err.name === 'NotAllowedError' && !pendingPlay) {
                pendingPlay = true;
                overlay.style.display = "flex";
            }
        });
    };

    setInterval(() => {
        if (!hasJoined || !shouldBePlaying) return;
        if (audio.readyState < 3) return;

        const isActuallyMoving = audio.currentTime > lastKnownTime;
        lastKnownTime = audio.currentTime;

        if (audio.paused || !isActuallyMoving) {
            forcePlay();
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
        updatePositionState();
    });

    // Ensure the lock screen scrubber is corrected if the audio seeks (either locally or via remote Server Sync)
    audio.addEventListener('seeked', updatePositionState);
    audio.addEventListener('ratechange', updatePositionState);

    const togglePlayPause = () => {
        if (navigator.vibrate) navigator.vibrate(50);
        if (audio.paused) {
            shouldBePlaying = true;
            audio.play().catch(e => console.log("Play blocked:", e));
            socket.sendCommand("play", { time: audio.currentTime });
        } else {
            shouldBePlaying = false;
            audio.pause();
            socket.sendCommand("pause", { time: audio.currentTime });
        }
    };

    playPauseBtn.onclick = togglePlayPause;
    miniPlayPauseBtn.onclick = togglePlayPause;

    progressBar.addEventListener('input', () => {
        isDraggingProgress = true;
        currentTimeDisp.innerText = formatTime(progressBar.value);
    });

    progressBar.addEventListener('change', () => {
        isDraggingProgress = false;
        if (navigator.vibrate) navigator.vibrate(20);
        socket.sendCommand("seek", { time: parseFloat(progressBar.value), isPlaying: shouldBePlaying });
    });

    audio.onplay = () => {
        playPauseBtn.innerHTML = Icons.pause;
        miniPlayPauseBtn.innerHTML = Icons.pause;
        coverArt.classList.add("playing");
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updatePositionState();
    };

    audio.onpause = () => {
        if (!shouldBePlaying) {
            playPauseBtn.innerHTML = Icons.play;
            miniPlayPauseBtn.innerHTML = Icons.play;
            coverArt.classList.remove("playing");
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
            updatePositionState();
        }
    };

    const svgVolume = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    const svgVolumeMute = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';

    const updateVolumeIcon = () => {
        if (!volumeIcon) return;
        volumeIcon.innerHTML = (isMuted || audio.volume === 0) ? svgVolumeMute : svgVolume;
    };

    if (volumeIcon) {
        volumeIcon.style.cursor = 'pointer';
        volumeIcon.onclick = () => {
            if (navigator.vibrate) navigator.vibrate(30);
            if (isMuted) {
                isMuted = false;
                audio.volume = volumeBeforeMute;
                volumeSlider.value = volumeBeforeMute;
                socket.sendCommand("volume", { level: volumeBeforeMute });
            } else {
                isMuted = true;
                volumeBeforeMute = audio.volume || 1;
                audio.volume = 0;
                volumeSlider.value = 0;
                socket.sendCommand("volume", { level: 0 });
            }
            updateVolumeIcon();
        };
    }

    volumeSlider.addEventListener('input', () => {
        isMuted = false;
        audio.volume = volumeSlider.value;
        localStorage.setItem("syncMusicVolume", volumeSlider.value);
        socket.sendCommand("volume", { level: parseFloat(volumeSlider.value) });
        updateVolumeIcon();
    });

    const handleEagerLoadAndPlay = (targetPath) => {
        if (currentSongPath !== targetPath || !currentSongPath) {
            audio.src = "/music/" + encodePath(targetPath);
            currentSongPath = targetPath;
            updateNowPlaying(currentSongPath);
        }
        shouldBePlaying = true;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        forcePlay();
    };

    const playNext = (isNaturalEnd = false) => {
        if (navigator.vibrate) navigator.vibrate(30);

        // Guard against race: both natural end AND manual skip firing at the same time.
        // Manual skip uses a short 300ms window (enough to absorb a simultaneous onended).
        // Natural end keeps 2000ms to handle network/latency-delayed duplicates.
        if (isHandlingEnd) return;
        isHandlingEnd = true;
        setTimeout(() => { isHandlingEnd = false; }, isNaturalEnd ? 2000 : 300);

        if (isNaturalEnd && isRepeat === 2) {
            socket.sendCommand("seek", { time: 0, isPlaying: true });
            audio.currentTime = 0;
            shouldBePlaying = true;
            forcePlay();
            return;
        }

        // Clear forwardHistory on natural progression (not going back-then-forward)
        if (isNaturalEnd) forwardHistory = [];

        if (currentSongPath && isRepeat !== 2) {
            playedHistory.push(currentSongPath);
            // Cap history size to avoid unbounded memory growth
            if (playedHistory.length > MAX_HISTORY) playedHistory.shift();
        }

        if (globalQueue.length > 0) {
            const nextItem = globalQueue[0];
            socket.sendCommand("load", { song: nextItem.path, folder: "Queue" });
            socket.sendCommand("dequeue", { id: nextItem.id });
            handleEagerLoadAndPlay(nextItem.path);
            return;
        }

        if (currentPlaylist.length === 0) return;

        let nextSongPath;
        if (isShuffle) {
            // If we went back and now go forward again, replay the known next track
            if (forwardHistory.length > 0) {
                nextSongPath = forwardHistory.pop();
            } else {
                if (shuffleQueue.length === 0) {
                    // Generate and shuffle new queue
                    shuffleQueue = Array.from({length: currentPlaylist.length}, (_, i) => i);
                    for (let i = shuffleQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffleQueue[i], shuffleQueue[j]] = [shuffleQueue[j], shuffleQueue[i]];
                    }
                    // Avoid immediate repeat of current song if we just re-shuffled
                    const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
                    if (shuffleQueue[shuffleQueue.length - 1] === currentIndex && currentPlaylist.length > 1) {
                        [shuffleQueue[shuffleQueue.length - 1], shuffleQueue[0]] = [shuffleQueue[0], shuffleQueue[shuffleQueue.length - 1]];
                    }
                }
                nextSongPath = currentPlaylist[shuffleQueue.pop()].path;
            }
        } else {
            const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
            let nextIndex = currentIndex + 1;
            if (nextIndex >= currentPlaylist.length) {
                if (isRepeat === 0 && isNaturalEnd) {
                    socket.sendCommand("pause", { time: 0 });
                    return;
                }
                nextIndex = 0;
            }
            nextSongPath = currentPlaylist[nextIndex].path;
        }
        socket.sendCommand("load", { song: nextSongPath, folder: currentFolderName });
        handleEagerLoadAndPlay(nextSongPath);
    };

    const playPrev = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        if (currentPlaylist.length === 0) return;

        // Spotify-style: if we're more than 3s into the track, seek to start instead of going back
        if (audio.currentTime > 3) {
            socket.sendCommand("seek", { time: 0, isPlaying: shouldBePlaying });
            audio.currentTime = 0;
            return;
        }

        if (playedHistory.length > 0) {
            // Save current song so going forward again returns here
            if (currentSongPath) {
                forwardHistory.push(currentSongPath);
                if (forwardHistory.length > MAX_HISTORY) forwardHistory.shift();
            }
            const prevSongPath = playedHistory.pop();
            socket.sendCommand("load", { song: prevSongPath, isPrev: true, folder: currentFolderName });
            handleEagerLoadAndPlay(prevSongPath);
            return;
        }

        const currentIndex = currentPlaylist.findIndex(s => s.path === currentSongPath);
        let prevIndex = currentIndex - 1 < 0 ? currentPlaylist.length - 1 : currentIndex - 1;
        const prevSongPath = currentPlaylist[prevIndex].path;
        socket.sendCommand("load", { song: prevSongPath, isPrev: true, folder: currentFolderName });
        handleEagerLoadAndPlay(prevSongPath);
    };

    document.getElementById("nextBtn").onclick = () => playNext(false);
    miniNextBtn.onclick = () => playNext(false);
    document.getElementById("prevBtn").onclick = playPrev;
    miniPrevBtn.onclick = playPrev;
    audio.onended = () => { playNext(true); };

    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => {
            shouldBePlaying = true;
            audio.play();
            socket.sendCommand("play", { time: audio.currentTime });
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            shouldBePlaying = false;
            audio.pause();
            socket.sendCommand("pause", { time: audio.currentTime });
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
        navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
        // Seek actions
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            const skipTime = details.seekOffset || 10;
            const newTime = Math.max(audio.currentTime - skipTime, 0);
            socket.sendCommand("seek", { time: newTime, isPlaying: shouldBePlaying });
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            const skipTime = details.seekOffset || 10;
            const newTime = Math.min(audio.currentTime + skipTime, audio.duration || 0);
            socket.sendCommand("seek", { time: newTime, isPlaying: shouldBePlaying });
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            socket.sendCommand("seek", { time: details.seekTime, isPlaying: shouldBePlaying });
        });
    }

    const handleJoinUserInit = () => {
        hasJoined = true;
        pendingPlay = false;

        let waitTimeSeconds = 0;
        if (shouldBePlaying) {
            waitTimeSeconds = (Date.now() - syncReceivedTime) / 1000;
        }
        let targetTime = syncAudioTime + waitTimeSeconds;

        // Prevent race condition: if calculated time exceeds duration (network lag),
        // clamping it prevents instantly firing 'onended' and skipping track for everyone.
        if (audio.duration && targetTime >= audio.duration) {
            targetTime = Math.max(0, audio.duration - 0.5);
        }

        audio.currentTime = targetTime;
        if (shouldBePlaying) {
            audio.play().catch(e => console.error("Play error:", e));
        }
    };

    return {
        handleJoinUserInit,
        handleSocketMessage: (msg) => {
            let offsetTime = msg.time;

            // Adjust offsetTime if server_ts is provided (Precision Sync)
            if (msg.server_ts && socket.getServerTime && msg.action !== "pause") {
                let timePassedSinceServerSent = (socket.getServerTime() - msg.server_ts) / 1000;
                // Clamp network skew to handle OS hardware clock drift bounds (-2s to 5s max valid range)
                timePassedSinceServerSent = Math.max(-2, Math.min(5, timePassedSinceServerSent));
                
                // Add minimum bound to prevent negative times if clocks skew wildly
                offsetTime = msg.time + Math.max(0, timePassedSinceServerSent);
            }

            if (msg.action === "sync") {
                if (msg.queue !== undefined) {
                    globalQueue = msg.queue || [];
                    if (onQueueUpdateCallback) onQueueUpdateCallback(globalQueue);
                }
                if (msg.folder) {
                    currentFolderName = msg.folder;
                    if (allGroupsCache[msg.folder]) {
                        currentPlaylist = allGroupsCache[msg.folder];
                    }
                }
                
                const songChanged = currentSongPath !== msg.song;
                
                if (songChanged || !currentSongPath) {
                    audio.src = "/music/" + encodePath(msg.song);
                    currentSongPath = msg.song;
                    updateNowPlaying(currentSongPath);
                }
                
                const drift = Math.abs(audio.currentTime - offsetTime);
                if (songChanged || drift > softSyncThreshold) {
                    audio.currentTime = offsetTime;
                }
                
                syncReceivedTime = Date.now();
                syncAudioTime = offsetTime;
                shouldBePlaying = msg.isPlaying;
                if (shouldBePlaying) forcePlay();
                if (msg.isShuffle !== undefined) updateShuffleUI(msg.isShuffle);
                if (msg.isRepeat !== undefined) updateRepeatUI(msg.isRepeat);
                if (msg.volume !== undefined) {
                    audio.volume = msg.volume;
                    volumeSlider.value = msg.volume;
                }

            } else if (msg.action === "queue_update") {
                globalQueue = msg.queue || [];
                if (onQueueUpdateCallback) onQueueUpdateCallback(globalQueue);
            } else if (msg.action === "load") {
                if (msg.folder && allGroupsCache[msg.folder]) {
                    if (currentFolderName !== msg.folder) { shuffleQueue = []; forwardHistory = []; }
                    currentFolderName = msg.folder;
                    currentPlaylist = allGroupsCache[msg.folder];
                }
                if (!msg.isPrev && currentSongPath && currentSongPath !== msg.song) {
                    playedHistory.push(currentSongPath);
                    forwardHistory = []; // Manual forward jump clears the redo stack
                } else if (msg.isPrev) {
                    if (playedHistory.length > 0 && playedHistory[playedHistory.length - 1] === msg.song) playedHistory.pop();
                }
                if (currentSongPath !== msg.song || !currentSongPath) {
                    audio.src = "/music/" + encodePath(msg.song);
                    currentSongPath = msg.song;
                    updateNowPlaying(currentSongPath);
                }
                shouldBePlaying = true;
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                forcePlay();

            } else if (msg.action === "play") {
                const drift = Math.abs(audio.currentTime - offsetTime);
                if (hasJoined && drift > softSyncThreshold) {
                    audio.currentTime = offsetTime;
                }
                shouldBePlaying = true;
                syncAudioTime = offsetTime;
                syncReceivedTime = Date.now();
                forcePlay();
            } else if (msg.action === "pause") {
                shouldBePlaying = false;
                if (hasJoined) audio.pause();
                if (hasJoined) audio.currentTime = msg.time;
                syncAudioTime = msg.time;
                syncReceivedTime = Date.now();
            } else if (msg.action === "seek") {
                if (hasJoined) audio.currentTime = offsetTime;
                shouldBePlaying = msg.isPlaying === undefined ? true : msg.isPlaying;
                lastKnownTime = -1;
                syncAudioTime = offsetTime;
                syncReceivedTime = Date.now();
                updatePositionState();
                if (shouldBePlaying) forcePlay();
            } else if (msg.action === "shuffle") updateShuffleUI(msg.state);
            else if (msg.action === "repeat") updateRepeatUI(msg.state);
            else if (msg.action === "volume") {
                audio.volume = msg.level;
                volumeSlider.value = msg.level;
            }
        },
        setCacheGroups: (groups) => {
            allGroupsCache = groups;
            // If we already received a sync before library loaded, hydrate the playlist now
            if (currentFolderName && currentPlaylist.length === 0 && allGroupsCache[currentFolderName]) {
                currentPlaylist = allGroupsCache[currentFolderName];
                precacheNextTracks(); // trigger immediate buffer for late joiners
            }
        },
        setCurrentPlaylistFolder: (folder) => { 
            if (currentFolderName !== folder) {
                shuffleQueue = []; // Reset shuffle queue on folder change
            }
            currentFolderName = folder; 
            currentPlaylist = allGroupsCache[folder]; 
        },
        onTrackChanged: (cb) => { onTrackChangeCallback = cb; },
        onQueueUpdate: (cb) => { onQueueUpdateCallback = cb; },
        getQueue: () => globalQueue,
        getCurrentState: () => ({ path: currentSongPath, folder: currentFolderName })
    };
}

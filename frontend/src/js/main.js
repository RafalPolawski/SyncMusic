import { fetchSongsLibrary } from './api.js';
import { SyncWebTransport } from './webtransport.js';
import { initPlayer } from './player.js';

/**
 * Main Application Entry Point
 * 
 * Responsible for orchestrating the application's lifecycle on the browser:
 * - Bootstrapping the WebTransport connection.
 * - Initializing the Music Player instance.
 * - Loading media libraries on startup and rendering the folder tree.
 */
document.addEventListener("DOMContentLoaded", () => {
    const nicknameInput = document.getElementById("nicknameInput");
    const savedNick = localStorage.getItem("syncMusicNick");
    if (savedNick) {
        nicknameInput.value = savedNick;
    }

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').then((registration) => {
                console.log('[SW] ServiceWorker registration successful with scope: ', registration.scope);
            }, (err) => {
                console.log('[SW] ServiceWorker registration failed: ', err);
            });
        });
    }

    const socket = new SyncWebTransport();
    const player = initPlayer(socket);

    socket.onMessage((msg) => {
        if (msg.action === "presence") {
            const usersList = document.getElementById("usersList");
            usersList.innerHTML = ""; // Clear existing
            if (msg.users && msg.users.length > 0) {
                msg.users.forEach(nick => {
                    const tag = document.createElement("div");
                    tag.className = "user-tag";
                    tag.innerText = nick;
                    usersList.appendChild(tag);
                });
            } else {
                usersList.innerHTML = "<span style='color: rgba(255,255,255,0.5); font-size: 14px;'>No listeners yet...</span>";
            }
        } else {
            player.handleSocketMessage(msg);
        }
    });

    // Global state for highlighting
    let globalPlayingPath = null;
    let globalPlayingFolder = null;

    const foldersContainer = document.getElementById("foldersContainer");
    const songsContainer = document.getElementById("songsContainer");
    const backBtn = document.getElementById("backBtn");
    const loadingIndicator = document.getElementById("loadingIndicator");
    const locateTrackBtn = document.getElementById("locateTrackBtn");

    const updateHighlights = () => {
        // Hydrate from player if missing (useful when player syncs before UI is built)
        if (!globalPlayingPath || !globalPlayingFolder) {
            const state = player.getCurrentState();
            if (state.path) globalPlayingPath = state.path;
            if (state.folder) globalPlayingFolder = state.folder;
        }

        // Clear all active classes
        document.querySelectorAll('.folder-btn').forEach(btn => btn.classList.remove('active-folder'));
        document.querySelectorAll('.item-btn:not(.folder-btn)').forEach(btn => btn.classList.remove('active-track'));

        // Highlight active folder if any
        if (globalPlayingFolder) {
            const folderBtn = document.querySelector(`.folder-btn[data-folder="${globalPlayingFolder}"]`);
            if (folderBtn) folderBtn.classList.add('active-folder');
        }

        let isTrackActiveInCurrentView = false;

        // Highlight active track
        if (globalPlayingPath) {
            const trackBtns = document.querySelectorAll('#songsContainer .item-btn');
            trackBtns.forEach(btn => {
                if (btn.dataset.path === globalPlayingPath) {
                    btn.classList.add('active-track');
                    isTrackActiveInCurrentView = true;
                }
            });
        }

        // Show or hide the Locate FAB based on if we are in a track view and the track is playing here
        if (isTrackActiveInCurrentView && songsContainer.style.display !== "none") {
            locateTrackBtn.classList.add('visible');
        } else {
            locateTrackBtn.classList.remove('visible');
        }
    };

    // Handle track changes from player.js to update highlights
    player.onTrackChanged((currentPath, currentFolder) => {
        globalPlayingPath = currentPath;
        globalPlayingFolder = currentFolder;
        updateHighlights();
    });

    locateTrackBtn.onclick = () => {
        const activeTrack = document.querySelector('.active-track');
        if (activeTrack) {
            activeTrack.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    const joinBtn = document.getElementById("joinBtn");

    const loadLibrary = () => {
        fetchSongsLibrary().then(data => {
            if (!data) return;

            if (data.is_scanning !== undefined && data.is_scanning === true) {
                loadingIndicator.style.display = "block";
                loadingIndicator.innerHTML = `
                    <div style="margin-bottom: 5px; font-weight: 500;">Scanning library...</div>
                    <div style="font-size: 16px; color: #1DB954; font-weight: bold;">
                        ${data.scan_current} / ${data.scan_total || '?'} tracks
                    </div>
                `;
                joinBtn.disabled = true;
                joinBtn.innerText = "SCANNING...";
                joinBtn.style.opacity = "0.5";
                joinBtn.style.cursor = "not-allowed";
                setTimeout(loadLibrary, 1000);
                return;
            }

            joinBtn.disabled = false;
            joinBtn.innerText = "JOIN SESSION 🎧";
            joinBtn.style.opacity = "1";
            joinBtn.style.cursor = "pointer";

            const songs = data;
            loadingIndicator.style.display = "none";
            if (!songs || songs.length === 0) return;
            const groups = {};
            songs.forEach(song => {
                const path = song.path;
                const parts = path.split('/');
                const folder = parts.length > 1 ? parts[0] : "Loose Tracks";
                if (!groups[folder]) groups[folder] = [];
                groups[folder].push({
                    path: path,
                    artist: song.artist,
                    title: song.title
                });
            });

            player.setCacheGroups(groups);

            let savedScrollWindow = 0;
            let savedScrollPanel = 0;

            const showFolders = () => {
                foldersContainer.style.display = "block";
                songsContainer.style.display = "none";
                backBtn.style.display = "none";
                locateTrackBtn.classList.remove('visible');
                foldersContainer.innerHTML = "";

                for (const f in groups) {
                    const b = document.createElement("button");
                    b.className = "item-btn folder-btn";
                    // Optionally highlight folder on first render if it matches something playing (optional, handled after anyway if event fires)
                    b.dataset.folder = f;
                    b.innerText = `📁 ${f} (${groups[f].length})`;
                    b.onclick = () => {
                        // Save scroll position before hiding folders
                        savedScrollWindow = window.scrollY || document.documentElement.scrollTop;
                        const rp = document.querySelector('.right-panel');
                        savedScrollPanel = rp ? rp.scrollTop : 0;

                        foldersContainer.style.display = "none";
                        songsContainer.style.display = "block";
                        backBtn.style.display = "block";
                        songsContainer.innerHTML = "";
                        locateTrackBtn.classList.remove('visible'); // Will be re-added inside updateHighlights if needed

                        player.setCurrentPlaylistFolder(f);

                        groups[f].forEach(s => {
                            const sb = document.createElement("button");
                            sb.className = "item-btn";
                            sb.dataset.path = s.path;

                            const safeEncode = encodeURIComponent(s.path).replace(/'/g, "%27").replace(/"/g, "%22");
                            const thumbUrl = `/api/cover?song=${safeEncode}`;

                            sb.innerHTML = `
                            <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'45\\' height=\\'45\\'><rect width=\\'45\\' height=\\'45\\' fill=\\'%23333\\'/><text x=\\'50%\\' y=\\'50%\\' font-size=\\'20\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\' fill=\\'%23555\\'>🎵</text></svg>'">
                            <div class="song-info">
                                <span class="song-name">${s.title}</span>
                                <span class="song-artist">${s.artist}</span>
                            </div>
                        `;

                            sb.onclick = () => {
                                // Don't update player's folder directly here to prevent UI desyncs before WS response
                                // The server load response will update the player and fire onTrackChanged anyway
                                socket.sendCommand("load", { song: s.path, folder: f });
                            };
                            songsContainer.appendChild(sb);
                        });

                        // Reapply highlights since DOM elements were just recreated for the songs view
                        updateHighlights();

                        // Reset scroll to top for the new playlist view
                        window.scrollTo(0, 0);
                        if (rp) rp.scrollTo(0, 0);
                    };
                    foldersContainer.appendChild(b);
                }

                // Restore scroll position after rendering folders
                window.scrollTo(0, savedScrollWindow);
                const rp = document.querySelector('.right-panel');
                if (rp) rp.scrollTo(0, savedScrollPanel);
            };

            showFolders();
            backBtn.onclick = showFolders;

            // Ensure highlights are applied if changing back to folders view
            backBtn.addEventListener('click', updateHighlights);
            // Force highlight evaluation upon initial load just in case player was already initialized
            updateHighlights();

            // Handle joining
            document.getElementById("joinBtn").onclick = () => {
                let nick = nicknameInput.value.trim();
                if (!nick) {
                    nick = "Anonymous Music Lover";
                }
                localStorage.setItem("syncMusicNick", nick);

                // Send the join command
                socket.sendCommand("join", { nickname: nick });

                // Re-bind to start playing right away if time was synced
                const overlay = document.getElementById("overlay");
                overlay.style.display = "none";
                player.handleJoinUserInit();
            };

            // If the server dropped and reconnected, resend the join command
            socket.onReconnect = () => {
                const nick = localStorage.getItem("syncMusicNick");
                if (nick) {
                    socket.sendCommand("join", { nickname: nick });
                }
            };
        }).catch(err => {
            console.error("Failed to fetch library, retrying in 2s...", err);
            setTimeout(loadLibrary, 2000);
        });
    }; // end of loadLibrary

    // Start initial load
    loadLibrary();
});

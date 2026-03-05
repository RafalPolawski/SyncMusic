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
        player.handleSocketMessage(msg);
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

    fetchSongsLibrary().then(songs => {
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
                };
                foldersContainer.appendChild(b);
            }
        };

        showFolders();
        backBtn.onclick = showFolders;

        // Ensure highlights are applied if changing back to folders view
        backBtn.addEventListener('click', updateHighlights);
        // Force highlight evaluation upon initial load just in case player was already initialized
        updateHighlights();
    });
});

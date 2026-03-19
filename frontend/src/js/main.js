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

    // RTT latency indicator
    const rttIndicator = document.getElementById('rttIndicator');
    const rttDot       = document.getElementById('rttDot');
    const rttValue     = document.getElementById('rttValue');

    socket.onRttUpdate = (rtt) => {
        rttIndicator.style.display = 'inline-flex';
        rttValue.textContent = `${rtt}ms`;

        let color;
        if (rtt <= 50)       color = '#1DB954'; // green
        else if (rtt <= 150) color = '#f0c040'; // yellow
        else if (rtt <= 300) color = '#e07820'; // orange
        else                 color = '#e03030'; // red

        rttDot.style.background = color;
        // Brief pulse to show the value just updated
        rttDot.style.transform = 'scale(1.5)';
        setTimeout(() => { rttDot.style.transform = 'scale(1)'; }, 200);
    };
    rttDot.style.transition = 'background 0.6s ease, transform 0.2s ease';

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

    // SW → Page: handle cache_progress and cache_done messages
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data) return;

            if (data.action === 'cache_progress' && activeCacheState) {
                activeCacheState.done++;
                const pct = Math.round((activeCacheState.done / data.total) * 100);

                if (activeCacheState.fillEl) activeCacheState.fillEl.style.width = pct + '%';
                if (activeCacheState.labelEl) activeCacheState.labelEl.textContent = `${activeCacheState.done} / ${data.total}`;

                // Mark the individual song badge as cached
                // URL is either /music/... or /api/cover?song=...
                if (data.url) {
                    const url = new URL(data.url, window.location.origin);
                    let songPath = null;
                    if (url.pathname.startsWith('/music/')) {
                        songPath = decodeURIComponent(url.pathname.replace('/music/', ''));
                    }
                    if (songPath) {
                        const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(songPath)}"]`);
                        if (badge) { badge.classList.remove('caching'); badge.classList.add('cached'); badge.textContent = '✓'; }
                    }
                }
            }

            if (data.action === 'cache_done' && activeCacheState) {
                if (activeCacheState.fillEl) activeCacheState.fillEl.style.width = '100%';
                if (activeCacheState.labelEl) activeCacheState.labelEl.textContent = 'Done!';
                if (activeCacheState.btn) {
                    activeCacheState.btn.disabled = false;
                    activeCacheState.btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Cached`;
                    activeCacheState.btn.style.color = '#1DB954';
                }
                activeCacheState = null;
            }
        });
    }

    // Global state for highlighting
    let globalPlayingPath = null;
    let globalPlayingFolder = null;
    let activeTrackEl = null;  // direct ref to highlighted track element
    let activeFolderEl = null; // direct ref to highlighted folder element
    let activeCacheState = null; // tracks active playlist cache operation

    const foldersContainer = document.getElementById("foldersContainer");
    const songsContainer = document.getElementById("songsContainer");
    const backBtn = document.getElementById("backBtn");
    const loadingIndicator = document.getElementById("loadingIndicator");
    const locateTrackBtn = document.getElementById("locateTrackBtn");

    const tabLibrary = document.getElementById("tabLibrary");
    const tabQueue = document.getElementById("tabQueue");
    const libraryView = document.getElementById("libraryView");
    const queueView = document.getElementById("queueView");
    const queueContainer = document.getElementById("queueContainer");
    const queueCountBadge = document.getElementById("queueCountBadge");

    if (tabLibrary && tabQueue) {
        tabLibrary.onclick = () => {
            tabLibrary.classList.add("active-tab");
            tabQueue.classList.remove("active-tab");
            libraryView.style.display = "block";
            queueView.style.display = "none";
        };

        tabQueue.onclick = () => {
            tabQueue.classList.add("active-tab");
            tabLibrary.classList.remove("active-tab");
            queueView.style.display = "block";
            libraryView.style.display = "none";
        };
    }

    const renderQueue = (queue) => {
        if (!queueCountBadge || !queueContainer) return;
        queueCountBadge.innerText = queue.length;
        queueCountBadge.style.display = queue.length > 0 ? "inline-block" : "none";

        if (queue.length === 0) {
            queueContainer.innerHTML = '<div class="empty-queue-msg">Queue is empty.</div>';
            return;
        }

        queueContainer.innerHTML = "";
        queue.forEach((item, index) => {
            const qBtn = document.createElement("div"); // Using div to avoid button nesting issue
            qBtn.className = "item-btn"; // using item-btn style
            
            const safeEncode = encodeURIComponent(item.path).replace(/'/g, "%27").replace(/"/g, "%22");
            const thumbUrl = `/api/cover?song=${safeEncode}`;

            qBtn.innerHTML = `
                <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'45\\' height=\\'45\\'><rect width=\\'45\\' height=\\'45\\' fill=\\'%23333\\'/><text x=\\'50%\\' y=\\'50%\\' font-size=\\'20\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\' fill=\\'%23555\\'>🎵</text></svg>'">
                <div class="song-info">
                    <span class="song-name">${item.title}</span>
                    <span class="song-artist">${item.artist}</span>
                </div>
                <button class="remove-queue-btn" title="Remove from queue">
                    <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            `;

            // Double Click / Click to play immediately
            qBtn.onclick = (e) => {
                if (e.target.closest('.remove-queue-btn')) {
                    socket.sendCommand("dequeue", { id: item.id });
                    return;
                }
                socket.sendCommand("load", { song: item.path, folder: "Queue" });
                socket.sendCommand("dequeue", { id: item.id });
            };

            queueContainer.appendChild(qBtn);
        });
    };

    player.onQueueUpdate(renderQueue);

    const updateHighlights = () => {
        // Hydrate from player if missing (useful when player syncs before UI is built)
        if (!globalPlayingPath || !globalPlayingFolder) {
            const state = player.getCurrentState();
            if (state.path) globalPlayingPath = state.path;
            if (state.folder) globalPlayingFolder = state.folder;
        }

        // Remove old highlights via stored references (faster than querySelectorAll)
        if (activeFolderEl) activeFolderEl.classList.remove('active-folder');
        if (activeTrackEl) activeTrackEl.classList.remove('active-track');
        activeFolderEl = null;
        activeTrackEl = null;

        // Highlight active folder
        if (globalPlayingFolder) {
            const folderBtn = document.querySelector(`.folder-btn[data-folder="${globalPlayingFolder}"]`);
            if (folderBtn) { folderBtn.classList.add('active-folder'); activeFolderEl = folderBtn; }
        }

        let isTrackActiveInCurrentView = false;

        // Highlight active track
        if (globalPlayingPath) {
            const trackBtns = document.querySelectorAll('#songsContainer .item-btn');
            trackBtns.forEach(btn => {
                if (btn.dataset.path === globalPlayingPath) {
                    btn.classList.add('active-track');
                    activeTrackEl = btn;
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

    // Encode path segments for URL construction (same logic as player.js)
    const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

    // Check SW cache status for a list of songs and apply .cached to their badges
    const checkCacheStatus = async (songs) => {
        if (!('caches' in window)) return;
        try {
            const cache = await caches.open('syncmusic-cache-v3');
            const keys = await cache.keys();
            const cachedPaths = new Set(keys.map(r => {
                const u = new URL(r.url);
                if (u.pathname.startsWith('/music/')) {
                    return decodeURIComponent(u.pathname.slice('/music/'.length));
                }
                return null;
            }).filter(Boolean));
            songs.forEach(s => {
                if (cachedPaths.has(encodePath(s.path)) || cachedPaths.has(s.path)) {
                    const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(s.path)}"]`);
                    if (badge) { badge.classList.add('cached'); badge.textContent = '✓'; }
                }
            });
        } catch (e) { /* caches API unavailable */ }
    };

    let isPolling = false;

    const loadLibrary = () => {
        if (isPolling) return;
        isPolling = true;

        const poll = () => {
        fetchSongsLibrary().then(data => {
            if (!data) { isPolling = false; return; }

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
                setTimeout(poll, 1000);
                return;
            }

            isPolling = false;
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

                        // -- Cache playlist button + progress bar --
                        const cacheBtn = document.createElement('button');
                        cacheBtn.className = 'cache-playlist-btn';
                        cacheBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Cache ${groups[f].length} tracks for offline`;
                        songsContainer.appendChild(cacheBtn);

                        const progressWrap = document.createElement('div');
                        progressWrap.className = 'cache-progress-wrap';
                        progressWrap.innerHTML = `
                            <div class="cache-progress-track"><div class="cache-progress-fill" id="cacheProgressFill"></div></div>
                            <div class="cache-progress-label" id="cacheProgressLabel">0 / ${groups[f].length * 2}</div>
                        `;
                        songsContainer.appendChild(progressWrap);

                        cacheBtn.onclick = () => {
                            if (!confirm(`Cache ${groups[f].length} tracks for offline playback?`)) return;
                            if (!navigator.serviceWorker.controller) { alert('Service Worker not ready, try again in a moment.'); return; }

                            // Build URL list: audio + covers
                            const urls = [];
                            groups[f].forEach(s => {
                                urls.push('/music/' + encodePath(s.path));
                                urls.push('/api/cover?song=' + encodeURIComponent(s.path));
                                // Mark badge as "in progress"
                                const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(s.path)}"]`);
                                if (badge && !badge.classList.contains('cached')) {
                                    badge.classList.add('caching');
                                    badge.textContent = '';
                                }
                            });

                            progressWrap.classList.add('visible');
                            const fillEl = document.getElementById('cacheProgressFill');
                            const labelEl = document.getElementById('cacheProgressLabel');
                            if (fillEl) fillEl.style.width = '0%';
                            if (labelEl) labelEl.textContent = `0 / ${urls.length}`;

                            activeCacheState = { done: 0, btn: cacheBtn, fillEl, labelEl };
                            cacheBtn.disabled = true;

                            navigator.serviceWorker.controller.postMessage({ action: 'cache_playlist', urls });
                        };

                        // -- Render songs with cache badge --
                        groups[f].forEach(s => {
                            const sb = document.createElement("div");
                            sb.className = "item-btn";
                            sb.dataset.path = s.path;

                            const safeEncode = encodeURIComponent(s.path).replace(/'/g, "%27").replace(/"/g, "%22");
                            const thumbUrl = `/api/cover?song=${safeEncode}`;
                            const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='45' height='45'><rect width='45' height='45' fill='%23333'/><text x='50%' y='50%' font-size='20' text-anchor='middle' dominant-baseline='middle' fill='%23555'>🎵</text></svg>`;

                            sb.innerHTML = `
                            <div class="song-thumb-wrap">
                                <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='${fallbackSvg}'">
                                <span class="cache-badge" data-path="${s.path.replace(/"/g,'&quot;')}"></span>
                            </div>
                            <div class="song-info">
                                <span class="song-name">${s.title}</span>
                                <span class="song-artist">${s.artist}</span>
                            </div>
                            <button class="add-queue-btn" title="Add to Queue">
                                <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                            </button>
                        `;

                            sb.onclick = (e) => {
                                const addBtn = e.target.closest('.add-queue-btn');
                                if (addBtn) {
                                    socket.sendCommand("enqueue", { item: { path: s.path, title: s.title, artist: s.artist } });
                                    const icon = addBtn.innerHTML;
                                    addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                                    addBtn.style.color = "#1DB954";
                                    setTimeout(() => {
                                        addBtn.innerHTML = icon;
                                        addBtn.style.color = "";
                                    }, 1000);
                                    return;
                                }
                                socket.sendCommand("load", { song: s.path, folder: f });
                            };
                            songsContainer.appendChild(sb);
                        });

                        // Reapply highlights and check cache status
                        updateHighlights();
                        checkCacheStatus(groups[f]);

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
            isPolling = false;
            setTimeout(loadLibrary, 2000);
        });
        }; // end poll
        poll();
    }; // end of loadLibrary

    // Start initial load
    loadLibrary();
});

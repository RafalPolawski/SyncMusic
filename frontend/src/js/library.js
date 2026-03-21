import { fetchSongsLibrary } from './api.js';
import { UI, Utils, Icons } from './ui.js';
import { CacheManager } from './cache.js';

export function initLibrary(socket, player) {
    let globalPlayingPath = null;
    let globalPlayingFolder = null;
    let activeTrackEl = null;  
    let activeFolderEl = null; 

    const updateHighlights = () => {
        if (!globalPlayingPath || !globalPlayingFolder) {
            const state = player.getCurrentState();
            if (state.path) globalPlayingPath = state.path;
            if (state.folder) globalPlayingFolder = state.folder;
        }

        if (activeFolderEl) activeFolderEl.classList.remove('active-folder');
        if (activeTrackEl) activeTrackEl.classList.remove('active-track');
        activeFolderEl = null;
        activeTrackEl = null;

        if (globalPlayingFolder) {
            const folderBtn = document.querySelector(`.folder-btn[data-folder="${globalPlayingFolder}"]`);
            if (folderBtn) { folderBtn.classList.add('active-folder'); activeFolderEl = folderBtn; }
        }

        let isTrackActiveInCurrentView = false;
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

        if (isTrackActiveInCurrentView && UI.songsContainer.style.display !== "none") {
            UI.locateTrackBtn.classList.add('visible');
        } else {
            UI.locateTrackBtn.classList.remove('visible');
        }
    };

    player.onTrackChanged((currentPath, currentFolder) => {
        globalPlayingPath = currentPath;
        globalPlayingFolder = currentFolder;
        updateHighlights();
    });

    UI.locateTrackBtn.onclick = () => {
        const activeTrack = document.querySelector('.active-track');
        if (activeTrack) {
            activeTrack.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    let isPolling = false;

    const loadLibrary = () => {
        if (isPolling) return;
        isPolling = true;

        const poll = () => {
        fetchSongsLibrary().then(data => {
            if (!data) { 
                setTimeout(poll, 2000);
                return; 
            }

            if (data.is_scanning !== undefined && data.is_scanning === true) {
                UI.loadingIndicator.style.display = "block";
                UI.loadingIndicator.innerHTML = `
                    <div style="margin-bottom: 5px; font-weight: 500;">Scanning library...</div>
                    <div style="font-size: 16px; color: #1DB954; font-weight: bold;">
                        ${data.scan_current} / ${data.scan_total || '?'} tracks
                    </div>
                `;
                UI.joinBtn.disabled = true;
                UI.joinBtn.innerText = "SCANNING...";
                UI.joinBtn.style.opacity = "0.5";
                UI.joinBtn.style.cursor = "not-allowed";
                setTimeout(poll, 1000);
                return;
            }

            isPolling = false;
            UI.joinBtn.disabled = false;
            UI.joinBtn.innerText = "JOIN SESSION 🎧";
            UI.joinBtn.style.opacity = "1";
            UI.joinBtn.style.cursor = "pointer";

            const songs = data;
            UI.loadingIndicator.style.display = "none";
            if (!songs || songs.length === 0) return;
            const groups = {};
            let libraryTotalTracks = 0;
            let libraryTotalSize = 0;

            songs.forEach(song => {
                const path = song.path;
                const parts = path.split('/');
                const folder = parts.length > 1 ? parts[0] : "Loose Tracks";
                if (!groups[folder]) groups[folder] = [];
                libraryTotalTracks++;
                libraryTotalSize += song.size || 0;
                groups[folder].push({
                    path: path,
                    artist: song.artist,
                    title: song.title,
                    size: song.size || 0
                });
            });

            player.setCacheGroups(groups);

            let savedScrollWindow = 0;
            let savedScrollPanel = 0;
            let currentView = 'root';

            const showFolders = (fromHistory = false) => {
                if (!fromHistory && currentView !== 'root') {
                    history.pushState({ view: 'root' }, "");
                }
                currentView = 'root';

                UI.foldersContainer.style.display = "block";
                UI.songsContainer.style.display = "none";
                UI.backBtn.style.display = "none";
                UI.locateTrackBtn.classList.remove('visible');
                UI.foldersContainer.innerHTML = "";

                const cacheAllBtn = document.createElement("button");
                cacheAllBtn.className = "cache-playlist-btn";
                cacheAllBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Cache Library (${libraryTotalTracks} tracks, ~${Utils.formatBytes(libraryTotalSize)})`;
                UI.foldersContainer.appendChild(cacheAllBtn);

                const rescanBtn = document.createElement("button");
                rescanBtn.className = "cache-playlist-btn";
                rescanBtn.style.background = "rgba(255, 100, 100, 0.12)";
                rescanBtn.style.color = "#ff6b6b";
                rescanBtn.style.borderColor = "rgba(255, 100, 100, 0.35)";
                rescanBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> Rescan Library`;
                rescanBtn.onclick = () => {
                    if (!confirm("Are you sure you want to rescan the music directory? This may take a moment.")) return;
                    fetch("/api/rescan").then(() => {
                        isPolling = false;
                        loadLibrary();
                    }).catch(console.error);
                };
                UI.foldersContainer.appendChild(rescanBtn);

                const progressAllWrap = document.createElement('div');
                progressAllWrap.className = 'cache-progress-wrap';
                progressAllWrap.innerHTML = `
                    <div class="cache-progress-track"><div class="cache-progress-fill"></div></div>
                    <div class="cache-progress-label">0 / ${libraryTotalTracks * 2}</div>
                `;
                UI.foldersContainer.appendChild(progressAllWrap);

                const cacheId = 'library';
                const existingState = CacheManager.stateMap.get(cacheId);

                if (existingState) {
                    existingState.btn = cacheAllBtn;
                    existingState.fillEl = progressAllWrap.querySelector('.cache-progress-fill');
                    existingState.labelEl = progressAllWrap.querySelector('.cache-progress-label');

                    progressAllWrap.classList.add('visible');
                    cacheAllBtn.disabled = true;

                    const songsProcessed = Math.floor(existingState.done / 2);
                    const pct = Math.round((existingState.done / (libraryTotalTracks * 2)) * 100) || 0;
                    existingState.fillEl.style.width = pct + '%';
                    existingState.labelEl.textContent = `${songsProcessed} / ${libraryTotalTracks} songs`;
                } else {
                    cacheAllBtn.onclick = async () => {
                        if (!confirm(`Cache entire library (${libraryTotalTracks} tracks, ~${Utils.formatBytes(libraryTotalSize)}) for offline playback?`)) return;

                        let swReg;
                        try { 
                            swReg = await navigator.serviceWorker.getRegistration(); 
                            if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js');
                        } 
                        catch (e) { alert('Service Worker unavailable: ' + e.message); return; }
                        
                        const sw = (swReg && (swReg.active || swReg.waiting || swReg.installing)) || navigator.serviceWorker.controller;
                        if (!sw) { alert('Service Worker not active yet — please try again in a moment or disable "Bypass for network" in DevTools.'); return; }

                        const urls = [];
                        songs.forEach(s => {
                            urls.push('/music/' + Utils.encodePath(s.path));
                            urls.push('/api/cover?song=' + encodeURIComponent(s.path));
                        });

                        progressAllWrap.classList.add('visible');
                        const fillEl = progressAllWrap.querySelector('.cache-progress-fill');
                        const labelEl = progressAllWrap.querySelector('.cache-progress-label');
                        if (fillEl) fillEl.style.width = '0%';
                        if (labelEl) labelEl.textContent = `0 / ${libraryTotalTracks} songs`;

                        CacheManager.stateMap.set(cacheId, { done: 0, songCount: libraryTotalTracks, totalSize: libraryTotalSize, btn: cacheAllBtn, fillEl, labelEl });
                        cacheAllBtn.disabled = true;

                        sw.postMessage({ action: 'cache_playlist', urls, cacheId });
                    };
                }

                CacheManager.checkCacheStatus(songs, cacheAllBtn, libraryTotalSize);

                for (const f in groups) {
                    const b = document.createElement("button");
                    b.className = "item-btn folder-btn";
                    b.dataset.folder = f;
                    b.innerHTML = `📁 ${f} <span style="font-size:12px;opacity:0.6;margin-left:auto;">${groups[f].length}</span>`;

                    b.onclick = () => {
                        savedScrollWindow = window.scrollY || document.documentElement.scrollTop;
                        const rp = document.querySelector('.right-panel');
                        savedScrollPanel = rp ? rp.scrollTop : 0;

                        if (currentView !== 'playlist') {
                            history.pushState({ view: 'playlist', folder: f }, "");
                        }
                        currentView = 'playlist';

                        UI.foldersContainer.style.display = "none";
                        UI.songsContainer.style.display = "block";
                        UI.backBtn.style.display = "block";
                        UI.songsContainer.innerHTML = "";
                        UI.locateTrackBtn.classList.remove('visible'); 

                        let playlistSize = 0;
                        groups[f].forEach(s => playlistSize += s.size);

                        const cacheBtn = document.createElement("button");
                        cacheBtn.className = "cache-playlist-btn";
                        cacheBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Cache for offline (~${Utils.formatBytes(playlistSize)})`;
                        UI.songsContainer.appendChild(cacheBtn);

                        const progressWrap = document.createElement('div');
                        progressWrap.className = 'cache-progress-wrap';
                        progressWrap.innerHTML = `
                            <div class="cache-progress-track"><div class="cache-progress-fill"></div></div>
                            <div class="cache-progress-label">0 / ${groups[f].length * 2}</div>
                        `;
                        UI.songsContainer.appendChild(progressWrap);

                        const cacheId = 'folder-' + f;
                        const existingState = CacheManager.stateMap.get(cacheId);

                        if (existingState) {
                            existingState.btn = cacheBtn;
                            existingState.fillEl = progressWrap.querySelector('.cache-progress-fill');
                            existingState.labelEl = progressWrap.querySelector('.cache-progress-label');

                            progressWrap.classList.add('visible');
                            cacheBtn.disabled = true;

                            const songsProcessed = Math.floor(existingState.done / 2);
                            const pct = Math.round((existingState.done / (groups[f].length * 2)) * 100) || 0;
                            existingState.fillEl.style.width = pct + '%';
                            existingState.labelEl.textContent = `${songsProcessed} / ${groups[f].length} songs`;
                        } else {
                            cacheBtn.onclick = async () => {
                                if (!confirm(`Cache ${groups[f].length} tracks (~${Utils.formatBytes(playlistSize)}) for offline playback?`)) return;

                                let swReg;
                                try {
                                    swReg = await navigator.serviceWorker.getRegistration();
                                    if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js');
                                } catch (e) {
                                    alert('Service Worker unavailable: ' + e.message);
                                    return;
                                }
                                
                                const sw = (swReg && (swReg.active || swReg.waiting || swReg.installing)) || navigator.serviceWorker.controller;
                                if (!sw) {
                                    alert('Service Worker not active yet — please try again in a moment or disable "Bypass for network" in DevTools.');
                                    return;
                                }

                                const urls = [];
                                groups[f].forEach(s => {
                                    urls.push('/music/' + Utils.encodePath(s.path));
                                    urls.push('/api/cover?song=' + encodeURIComponent(s.path));
                                    const badge = document.querySelector(`.cache-badge[data-path="${CSS.escape(s.path)}"]`);
                                    if (badge && !badge.classList.contains('cached')) {
                                        badge.classList.add('caching');
                                        badge.textContent = '';
                                    }
                                });

                                progressWrap.classList.add('visible');
                                const fillEl = progressWrap.querySelector('.cache-progress-fill');
                                const labelEl = progressWrap.querySelector('.cache-progress-label');
                                if (fillEl) fillEl.style.width = '0%';
                                if (labelEl) labelEl.textContent = `0 / ${groups[f].length} songs`;

                                CacheManager.stateMap.set(cacheId, { done: 0, songCount: groups[f].length, totalSize: playlistSize, btn: cacheBtn, fillEl, labelEl });
                                cacheBtn.disabled = true;

                                sw.postMessage({ action: 'cache_playlist', urls, cacheId });
                            };
                        }

                        groups[f].forEach(s => {
                            const sb = document.createElement("div");
                            sb.className = "item-btn";
                            sb.dataset.path = s.path;

                            const safeEncode = encodeURIComponent(s.path).replace(/'/g, "%27").replace(/"/g, "%22");
                            const thumbUrl = `/api/cover?song=${safeEncode}`;
                            const fallbackSvgEscaped = Icons.fallbackCover.replace(/'/g, "\\'");

                            sb.innerHTML = `
                            <div class="song-thumb-wrap">
                                <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='${fallbackSvgEscaped}'">
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
                            UI.songsContainer.appendChild(sb);
                        });

                        updateHighlights();
                        CacheManager.checkCacheStatus(groups[f], cacheBtn, playlistSize);

                        window.scrollTo(0, 0);
                        if (rp) rp.scrollTo(0, 0);

                    };
                    UI.foldersContainer.appendChild(b);
                }

                window.scrollTo(0, savedScrollWindow);
                const rp = document.querySelector('.right-panel');
                if (rp) rp.scrollTo(0, savedScrollPanel);
            };

            showFolders(true);
            UI.backBtn.onclick = () => {
                history.back();
            };

            UI.backBtn.addEventListener('click', () => { setTimeout(updateHighlights, 50); });
            updateHighlights();

            window.addEventListener('popstate', (e) => {
                const state = e.state;
                if (!state) return;

                if (state.view === 'exit') {
                    if (confirm("Czy na pewno chcesz wyjść z aplikacji?")) {
                        history.back(); 
                    } else {
                        history.pushState({ view: 'root' }, "");
                        currentView = 'root';
                    }
                } else if (state.view === 'root') {
                    if (currentView !== 'root') {
                        showFolders(true);
                        updateHighlights();
                    }
                } else if (state.view === 'playlist') {
                    currentView = 'playlist';
                }
            });

            UI.joinBtn.onclick = () => {
                let nick = UI.nicknameInput.value.trim();
                if (!nick) { nick = "Anonymous Music Lover"; }
                localStorage.setItem("syncMusicNick", nick);

                history.replaceState({ view: 'exit' }, "");
                history.pushState({ view: 'root' }, "");
                currentView = 'root';

                socket.sendCommand("join", { nickname: nick });

                UI.overlay.style.display = "none";
                player.handleJoinUserInit();
            };

            socket.onReconnect = () => {
                const nick = localStorage.getItem("syncMusicNick");
                if (nick) {
                    socket.sendCommand("join", { nickname: nick });
                }
            };
        }).catch(err => {
            console.error("Failed to fetch library, retrying in 2s...", err);
            isPolling = false;
            setTimeout(poll, 2000); // Fixed from loadLibrary to poll
        });
        }; 
        poll();
    }; 

    loadLibrary();
}

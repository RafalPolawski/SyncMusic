/**
 * library/index.js – orchestrates library loading, folder/song views,
 * history, search, and join flow.
 */

import { fetchSongsLibrary } from '../api.js';
import { UI, Utils } from '../ui.js';
import { CacheManager } from '../cache.js';
import { createCacheWidget } from './cache-ui.js';
import { renderSongsView } from './songs-view.js';

export const initLibrary = (socket, player, tokenResolver) => {
    let globalPlayingPath   = null;
    let globalPlayingFolder = null;
    let activeTrackEl       = null;
    let activeFolderEl      = null;

    // ── Highlight management ──────────────────────────────────────────────────

    const updateHighlights = () => {
        if (!globalPlayingPath || !globalPlayingFolder) {
            const s = player.getCurrentState();
            if (s.path)   globalPlayingPath   = s.path;
            if (s.folder) globalPlayingFolder = s.folder;
        }

        if (activeFolderEl) activeFolderEl.classList.remove('active-folder');
        if (activeTrackEl)  activeTrackEl.classList.remove('active-track');
        activeFolderEl = null;
        activeTrackEl  = null;

        if (globalPlayingFolder) {
            const btn = document.querySelector(`.folder-btn[data-folder="${CSS.escape(globalPlayingFolder)}"]`);
            if (btn) { btn.classList.add('active-folder'); activeFolderEl = btn; }
        }

        let isTrackVisible = false;
        if (globalPlayingPath) {
            document.querySelectorAll('#songsContainer .item-btn').forEach(btn => {
                if (btn.dataset.path === globalPlayingPath) {
                    btn.classList.add('active-track');
                    activeTrackEl = btn;
                    isTrackVisible = true;
                }
            });
        }

        UI.locateTrackBtn.classList.toggle('visible',
            isTrackVisible && UI.songsContainer.style.display !== 'none'
        );
    };

    player.onTrackChanged((path, folder) => {
        globalPlayingPath   = path;
        globalPlayingFolder = folder;
        updateHighlights();
    });

    UI.locateTrackBtn.onclick = () => {
        document.querySelector('.active-track')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // ── Skeleton loader ───────────────────────────────────────────────────────

    const showSkeleton = () => {
        UI.loadingIndicator.style.display = 'block';
        UI.loadingIndicator.innerHTML = `
            <div class="skeleton-list">
                ${Array(6).fill(null).map(() => `
                    <div class="skeleton-item">
                        <div class="skeleton-thumb"></div>
                        <div class="skeleton-info">
                            <div class="skeleton-line" style="width:${45 + Math.random() * 40}%"></div>
                            <div class="skeleton-line short" style="width:${20 + Math.random() * 25}%"></div>
                        </div>
                    </div>`).join('')}
            </div>`;
    };

    // ── Core Navigation Variables ─────────────────────────────────────────────
    let savedScrollWindow = 0;
    let savedScrollPanel  = 0;
    let currentView       = 'root';

    // ── Join / Offline Logic (Bound permanently, safe from cache failure) ────

    if (UI.roomIdInput) {
        const savedRoom = localStorage.getItem('syncMusicRoom');
        if (savedRoom) UI.roomIdInput.value = savedRoom;
    }

    // Fetch active rooms on mount
    if (UI.activeRoomsList) UI.activeRoomsList.innerHTML = '<span style="color:rgba(255,255,255,0.4); font-size:12px;">Searching for active rooms...</span>';
    fetch('/api/rooms').then(res => res.json()).then(rooms => {
        if (rooms && rooms.length > 0 && UI.activeRoomsContainer && UI.activeRoomsList) {
            UI.activeRoomsContainer.style.display = 'block';
            UI.activeRoomsList.innerHTML = rooms.map(roomId => 
                `<button type="button" class="room-pill">${roomId}</button>`
            ).join('');
            
            document.querySelectorAll('.room-pill').forEach(pill => {
                pill.style.background = 'rgba(29, 185, 84, 0.2)';
                pill.style.border = '1px solid #1DB954';
                pill.style.color = '#fff';
                pill.style.padding = '4px 10px';
                pill.style.borderRadius = '16px';
                pill.style.fontSize = '12px';
                pill.style.cursor = 'pointer';
                pill.onclick = () => { if (UI.roomIdInput) UI.roomIdInput.value = pill.innerText; };
            });
        }
    }).catch(e => console.warn('Offline or failed to fetch rooms:', e));

    const startLocalOffline = () => {
        // Skips WebTransport entirely
        player.setOfflineStatus(true);
        history.replaceState({ view: 'exit' }, '');
        history.pushState({ view: 'root' }, '');
        currentView = 'root';
        UI.overlay.style.display = 'none';
        
        // Hide top status for offline local mode
        if (document.querySelector('.app-bar-status')) {
            document.querySelector('.app-bar-status').style.display = 'none';
        }
    };

    const performJoin = () => {
        let nick = UI.nicknameInput.value.trim() || 'Anonymous';
        let room = (UI.roomIdInput && UI.roomIdInput.value.trim()) ? UI.roomIdInput.value.trim() : 'global';
        
        localStorage.setItem('syncMusicNick', nick);
        localStorage.setItem('syncMusicRoom', room);
        
        history.replaceState({ view: 'exit' }, '');
        history.pushState({ view: 'root' }, '');
        currentView = 'root';
        
        // Send join with Room ID and Token (if authorized)
        let token = tokenResolver ? tokenResolver() : null;
        socket.sendCommand('join', { nickname: nick, room_id: room, token: token });
        UI.overlay.style.display = 'none';
        player.handleJoinUserInit();
    };

    if (UI.offlineModeBtn) UI.offlineModeBtn.onclick = startLocalOffline;
    if (UI.joinBtn) UI.joinBtn.onclick = performJoin;

    socket.onReconnect = () => {
        const nick = localStorage.getItem('syncMusicNick');
        const room = localStorage.getItem('syncMusicRoom') || 'global';
        let token = tokenResolver ? tokenResolver() : null;
        if (nick && !player.isOfflineMode) socket.sendCommand('join', { nickname: nick, room_id: room, token: token });
    };

    // ── Library polling w/ exponential back-off ───────────────────────────────

    let isPolling = false;
    let wasScanning = false; // track if we were just scanning

    const loadLibrary = () => {
        if (isPolling) return;
        isPolling = true;
        showSkeleton();

        const poll = (retryDelay = 1000) => {
            fetchSongsLibrary().then(data => {
                if (!data) {
                    setTimeout(() => poll(Math.min(retryDelay * 2, 8000)), retryDelay);
                    return;
                }

                // Still scanning — show progress and retry at 1s
                if (data.is_scanning === true) {
                    wasScanning = true;
                    const c = data.scan_current || 0;
                    const t = data.scan_total || 1;
                    const pct = Math.min(100, Math.round((c / t) * 100));

                    UI.loadingIndicator.style.display = 'block';
                    UI.loadingIndicator.innerHTML = `
                        <div class="scan-progress" style="width: 100%; max-width: 300px; margin: 0 auto; text-align: left;">
                            <div style="font-weight:600; margin-bottom:10px; display:flex; justify-content:space-between;">
                                <span><span class="scan-icon">🔍</span> Scanning library…</span>
                                <span style="color:var(--primary);">${pct}%</span>
                            </div>
                            <div style="width:100%; height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden;">
                                <div style="width:${pct}%; height:100%; background:var(--primary); transition:width 0.3s ease;"></div>
                            </div>
                            <div class="scan-count" style="margin-top:8px; font-size:13px; color:rgba(255,255,255,0.5);">${c} files found</div>
                        </div>`;
                    UI.joinBtn.disabled   = true;
                    UI.joinBtn.innerText  = 'SCANNING…';
                    UI.joinBtn.style.opacity = '0.5';
                    UI.joinBtn.style.cursor  = 'not-allowed';
                    setTimeout(() => poll(1000), 1000);
                    return;
                }

                isPolling = false;
                UI.joinBtn.disabled      = false;
                UI.joinBtn.innerText     = 'JOIN SESSION 🎧';
                UI.joinBtn.style.opacity = '1';
                UI.joinBtn.style.cursor  = 'pointer';

                const songs = data;
                UI.loadingIndicator.style.display = 'none';
                if (!songs || songs.length === 0) return;

                // Group songs by top-level folder
                const groups = {};
                let libraryTotalTracks = 0;
                let libraryTotalSize   = 0;

                songs.forEach(song => {
                    const parts  = song.path.split('/');
                    const folder = parts.length > 1 ? parts[0] : 'Loose Tracks';
                    if (!groups[folder]) groups[folder] = [];
                    libraryTotalTracks++;
                    libraryTotalSize += song.size || 0;
                    groups[folder].push({ path: song.path, artist: song.artist, title: song.title, size: song.size || 0 });
                });

                player.setCacheGroups(groups);

                // Show search bar and wire it up
                UI.searchContainer.style.display = 'block';
                initSearch(songs, groups);

                // ── Folder list (root) view ───────────────────────────────────

                const showFolders = (fromHistory = false) => {
                    if (!fromHistory && currentView !== 'root') history.pushState({ view: 'root' }, '');
                    currentView = 'root';

                    UI.foldersContainer.style.display = 'block';
                    UI.songsContainer.style.display   = 'none';
                    UI.backBtn.style.display          = 'none';
                    UI.locateTrackBtn.classList.remove('visible');
                    UI.foldersContainer.innerHTML     = '';
                    UI.settingsActionContainer.innerHTML = '';

                    // Cache library button
                    createCacheWidget({
                        container: UI.settingsActionContainer,
                        cacheId:   'library',
                        songs,
                        totalSize: libraryTotalSize,
                        label:     `Cache Library (${libraryTotalTracks} tracks, ~${Utils.formatBytes(libraryTotalSize)})`,
                    });

                    // Rescan button
                    const rescanBtn = document.createElement('button');
                    rescanBtn.className = 'cache-playlist-btn';
                    rescanBtn.style.cssText = 'background:rgba(255,100,100,0.12);color:#ff6b6b;border-color:rgba(255,100,100,0.35);';
                    rescanBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> Rescan Library`;
                    rescanBtn.onclick = () => {
                        if (!confirm('Are you sure you want to rescan the music directory?')) return;
                        fetch('/api/rescan').then(() => {
                            isPolling = false;
                            UI.settingsOverlay.style.display = 'none';
                            loadLibrary();
                        }).catch(console.error);
                    };
                    UI.settingsActionContainer.appendChild(rescanBtn);

                    // Folder list
                    for (const f in groups) {
                        const b = document.createElement('button');
                        b.className  = 'item-btn folder-btn';
                        b.dataset.folder = f;

                        b.appendChild(document.createTextNode('📁 '));

                        const nameSpan = document.createElement('span');
                        nameSpan.textContent = f;
                        b.appendChild(nameSpan);

                        const countSpan = document.createElement('span');
                        countSpan.className = 'folder-count';
                        countSpan.textContent = groups[f].length;
                        b.appendChild(countSpan);

                        b.onclick = () => showSongs(f);
                        UI.foldersContainer.appendChild(b);
                    }

                    window.scrollTo(0, savedScrollWindow);
                    const rp = document.querySelector('.right-panel');
                    if (rp) rp.scrollTo(0, savedScrollPanel);
                };

                // ── Song list (folder) view ───────────────────────────────────

                const showSongs = (f) => {
                    savedScrollWindow = window.scrollY || document.documentElement.scrollTop;
                    const rp = document.querySelector('.right-panel');
                    savedScrollPanel  = rp ? rp.scrollTop : 0;

                    if (currentView !== 'playlist') history.pushState({ view: 'playlist', folder: f }, '');
                    currentView = 'playlist';

                    UI.foldersContainer.style.display = 'none';
                    UI.songsContainer.style.display   = 'block';
                    UI.backBtn.style.display          = 'block';
                    UI.locateTrackBtn.classList.remove('visible');

                    const playlistSize = groups[f].reduce((acc, s) => acc + s.size, 0);

                    const cacheContainer = document.createElement('div');
                    UI.songsContainer.innerHTML = '';
                    UI.songsContainer.appendChild(cacheContainer);

                    createCacheWidget({
                        container: cacheContainer,
                        cacheId:   'folder-' + f,
                        songs:     groups[f],
                        totalSize: playlistSize,
                        label:     `Cache for offline (~${Utils.formatBytes(playlistSize)})`,
                    });

                    renderSongsView(
                        f,
                        groups[f],
                        (song) => player.loadTrack(song.path, f),
                        (song, addBtn) => {
                            socket.sendCommand('enqueue', { item: { path: song.path, title: song.title, artist: song.artist } });
                            const original = addBtn.innerHTML;
                            addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                            addBtn.style.color = '#1DB954';
                            setTimeout(() => { addBtn.innerHTML = original; addBtn.style.color = ''; }, 1000);
                        }
                    );

                    updateHighlights();
                    CacheManager.checkCacheStatus(groups[f], null, playlistSize);

                    window.scrollTo(0, 0);
                    if (rp) rp.scrollTo(0, 0);
                };

                // ── History / back button ─────────────────────────────────────

                showFolders(true);
                UI.backBtn.onclick = () => history.back();
                UI.backBtn.addEventListener('click', () => setTimeout(updateHighlights, 50));
                updateHighlights();

                window.addEventListener('popstate', (e) => {
                    const s = e.state;
                    if (!s) return;
                    if (s.view === 'exit') {
                        if (confirm('Czy na pewno chcesz wyjść z aplikacji?')) {
                            history.back();
                        } else {
                            history.pushState({ view: 'root' }, '');
                            currentView = 'root';
                        }
                    } else if (s.view === 'root') {
                        if (currentView !== 'root') { showFolders(true); updateHighlights(); }
                    } else if (s.view === 'playlist') {
                        currentView = 'playlist';
                    }
                });

                if (wasScanning && songs && songs.length > 0) {
                    wasScanning = false;
                    setTimeout(performJoin, 300); // Auto-jump into the app without clicking
                }

            }).catch(err => {
                console.error('Failed to fetch library, retrying…', err);
                isPolling = false;
                setTimeout(() => poll(Math.min(retryDelay * 2, 8000)), retryDelay);
            });
        };

        poll();
    };

    // ── Search ────────────────────────────────────────────────────────────────

    const initSearch = (songs, groups) => {
        if (!UI.searchInput) return;
        let searchDebounce = null;

        UI.searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => runSearch(songs, groups), 200);
        });

        // Clear search when navigating away
        UI.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                UI.searchInput.value = '';
                clearSearch();
            }
        });
    };

    const runSearch = (songs, groups) => {
        const q = UI.searchInput.value.trim().toLowerCase();

        if (!q) { clearSearch(); return; }

        const matched = songs.filter(s =>
            s.title.toLowerCase().includes(q) ||
            s.artist.toLowerCase().includes(q) ||
            s.path.toLowerCase().includes(q)
        );

        UI.foldersContainer.style.display = 'none';
        UI.songsContainer.style.display   = 'none';
        UI.backBtn.style.display          = 'none';
        UI.searchResults.style.display    = 'block';
        UI.locateTrackBtn.classList.remove('visible');

        UI.searchResults.innerHTML = '';

        if (matched.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'search-empty';
            empty.textContent = 'No tracks found.';
            UI.searchResults.appendChild(empty);
            return;
        }

        matched.forEach(s => {
            const parts  = s.path.split('/');
            const folder = parts.length > 1 ? parts[0] : 'Loose Tracks';

            const row = document.createElement('div');
            row.className = 'item-btn';
            row.dataset.path = s.path;

            const img = document.createElement('img');
            img.className = 'song-thumb';
            img.loading = 'lazy';
            img.width = 50;
            img.height = 50;
            img.alt = '';
            img.src = `/api/cover?song=${encodeURIComponent(s.path)}`;

            const info = document.createElement('div');
            info.className = 'song-info';

            const nameEl = document.createElement('span');
            nameEl.className = 'song-name';
            nameEl.textContent = s.title;

            const artistEl = document.createElement('span');
            artistEl.className = 'song-artist';
            artistEl.textContent = `${s.artist} · ${folder}`;

            info.appendChild(nameEl);
            info.appendChild(artistEl);

            const addBtn = document.createElement('button');
            addBtn.className = 'add-queue-btn';
            addBtn.title = 'Add to Queue';
            addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

            row.appendChild(img);
            row.appendChild(info);
            row.appendChild(addBtn);

            row.onclick = (e) => {
                if (e.target.closest('.add-queue-btn')) {
                    socket.sendCommand('enqueue', { item: { path: s.path, title: s.title, artist: s.artist } });
                    const original = addBtn.innerHTML;
                    addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                    addBtn.style.color = '#1DB954';
                    setTimeout(() => { addBtn.innerHTML = original; addBtn.style.color = ''; }, 1000);
                    return;
                }
                player.loadTrack(s.path, folder);
            };

            UI.searchResults.appendChild(row);
        });
    };

    const clearSearch = () => {
        UI.searchResults.style.display = 'none';
        UI.searchResults.innerHTML = '';
        UI.foldersContainer.style.display = 'block';
    };

    loadLibrary();
}

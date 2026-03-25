/**
 * library/index.js – orchestrates library loading, folder/song views, history, and join flow.
 */

import { fetchSongsLibrary } from '../api.js';
import { UI, Utils } from '../ui.js';
import { CacheManager } from '../cache.js';
import { createCacheWidget } from './cache-ui.js';
import { renderSongsView } from './songs-view.js';

export function initLibrary(socket, player) {
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
            const btn = document.querySelector(`.folder-btn[data-folder="${globalPlayingFolder}"]`);
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

        if (isTrackVisible && UI.songsContainer.style.display !== 'none') {
            UI.locateTrackBtn.classList.add('visible');
        } else {
            UI.locateTrackBtn.classList.remove('visible');
        }
    };

    player.onTrackChanged((path, folder) => {
        globalPlayingPath   = path;
        globalPlayingFolder = folder;
        updateHighlights();
    });

    UI.locateTrackBtn.onclick = () => {
        document.querySelector('.active-track')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // ── Library polling ───────────────────────────────────────────────────────

    let isPolling = false;

    const loadLibrary = () => {
        if (isPolling) return;
        isPolling = true;

        const poll = () => {
            fetchSongsLibrary().then(data => {
                if (!data) { setTimeout(poll, 2000); return; }

                // Still scanning
                if (data.is_scanning === true) {
                    UI.loadingIndicator.style.display = 'block';
                    UI.loadingIndicator.innerHTML = `
                        <div style="margin-bottom:5px;font-weight:500;">Scanning library...</div>
                        <div style="font-size:16px;color:#1DB954;font-weight:bold;">
                            ${data.scan_current} / ${data.scan_total || '?'} tracks
                        </div>
                    `;
                    UI.joinBtn.disabled   = true;
                    UI.joinBtn.innerText  = 'SCANNING...';
                    UI.joinBtn.style.opacity = '0.5';
                    UI.joinBtn.style.cursor  = 'not-allowed';
                    setTimeout(poll, 1000);
                    return;
                }

                isPolling = false;
                UI.joinBtn.disabled   = false;
                UI.joinBtn.innerText  = 'JOIN SESSION 🎧';
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

                let savedScrollWindow = 0;
                let savedScrollPanel  = 0;
                let currentView       = 'root';

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

                    // Cache library button (whole library)
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
                        if (!confirm('Are you sure you want to rescan the music directory? This may take a moment.')) return;
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
                        b.innerHTML  = `📁 ${f} <span style="font-size:12px;opacity:0.6;margin-left:auto;">${groups[f].length}</span>`;
                        b.onclick    = () => showSongs(f);
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

                    // Cache button for this folder (prepended before the track list)
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

                    // Track rows
                    renderSongsView(
                        f,
                        groups[f],
                        (song) => socket.sendCommand('load', { song: song.path, folder: f }),
                        (song, addBtn) => {
                            socket.sendCommand('enqueue', { item: { path: song.path, title: song.title, artist: song.artist } });
                            const original = addBtn.innerHTML;
                            addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                            addBtn.style.color = '#1DB954';
                            setTimeout(() => { addBtn.innerHTML = original; addBtn.style.color = ''; }, 1000);
                        }
                    );

                    updateHighlights();

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

                // ── Join button ───────────────────────────────────────────────

                UI.joinBtn.onclick = () => {
                    let nick = UI.nicknameInput.value.trim() || 'Anonymous Music Lover';
                    localStorage.setItem('syncMusicNick', nick);

                    history.replaceState({ view: 'exit' }, '');
                    history.pushState({ view: 'root' }, '');
                    currentView = 'root';

                    socket.sendCommand('join', { nickname: nick });
                    UI.overlay.style.display = 'none';
                    player.handleJoinUserInit();
                };

                socket.onReconnect = () => {
                    const nick = localStorage.getItem('syncMusicNick');
                    if (nick) socket.sendCommand('join', { nickname: nick });
                };

            }).catch(err => {
                console.error('Failed to fetch library, retrying in 2s...', err);
                isPolling = false;
                setTimeout(poll, 2000);
            });
        };

        poll();
    };

    loadLibrary();
}

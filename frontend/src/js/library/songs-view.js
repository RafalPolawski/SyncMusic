/**
 * Songs view – renders the track list when a folder is opened.
 * Uses DOM API exclusively (no innerHTML with user data) to prevent XSS.
 */

import { UI } from '../ui.js';

/**
 * Renders the song list for a given folder into `UI.songsContainer`.
 *
 * @param {string}      folderName
 * @param {object[]}    songs        - Array of { path, title, artist, size }
 * @param {Function}    onSongClick  - Called with `song` when a track row is clicked
 * @param {Function}    onEnqueue    - Called with `song, addBtn` when + is clicked
 */
export function renderSongsView(folderName, songs, onSongClick, onEnqueue) {
    // NOTE: do NOT clear UI.songsContainer here — the caller sets up the cache
    // widget above the track list before calling this function.

    const addQueueSVG = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

    songs.forEach(s => {
        const row = document.createElement('div');
        row.className = 'item-btn';
        row.dataset.path = s.path;

        // ── Thumbnail ─────────────────────────────────────────────────────────
        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'song-thumb-wrap';

        const img = document.createElement('img');
        img.className = 'song-thumb';
        img.loading = 'lazy';
        img.width = 50;
        img.height = 50;
        img.alt = '';
        img.src = `/api/cover?song=${encodeURIComponent(s.path)}`;

        // cache status badge (populated by CacheManager)
        const badge = document.createElement('span');
        badge.className = 'cache-badge';
        badge.dataset.path = s.path;

        thumbWrap.appendChild(img);
        thumbWrap.appendChild(badge);

        // ── Track info ────────────────────────────────────────────────────────
        const info = document.createElement('div');
        info.className = 'song-info';

        const nameEl = document.createElement('span');
        nameEl.className = 'song-name';
        nameEl.textContent = s.title; // textContent — safe against XSS

        const artistEl = document.createElement('span');
        artistEl.className = 'song-artist';
        artistEl.textContent = s.artist; // textContent — safe against XSS

        info.appendChild(nameEl);
        info.appendChild(artistEl);

        // ── Add-to-queue button ───────────────────────────────────────────────
        const addBtn = document.createElement('button');
        addBtn.className = 'add-queue-btn';
        addBtn.title = 'Add to Queue';
        addBtn.innerHTML = addQueueSVG; // static SVG, safe

        // ── Assemble & bind ───────────────────────────────────────────────────
        row.appendChild(thumbWrap);
        row.appendChild(info);
        row.appendChild(addBtn);

        row.onclick = (e) => {
            if (e.target.closest('.add-queue-btn')) {
                onEnqueue(s, addBtn);
                return;
            }
            onSongClick(s);
        };

        UI.songsContainer.appendChild(row);
    });
}

/**
 * Songs view – renders the track list when a folder is opened.
 */

import { UI, Icons } from '../ui.js';

/**
 * Renders the song list for a given folder into `UI.songsContainer`.
 *
 * @param {string}      folderName
 * @param {object[]}    songs        - Array of { path, title, artist, size }
 * @param {Function}    onSongClick  - Called with `song` when a track row is clicked
 * @param {Function}    onEnqueue    - Called with `song` when the + button is clicked
 */
export function renderSongsView(folderName, songs, onSongClick, onEnqueue) {
    // NOTE: do NOT clear UI.songsContainer here — the caller already set it up
    // with the cache widget above the track list.

    songs.forEach(s => {
        const sb = document.createElement('div');
        sb.className = 'item-btn';
        sb.dataset.path = s.path;

        const safeEncode = encodeURIComponent(s.path).replace(/'/g, '%27').replace(/"/g, '%22');
        const thumbUrl = `/api/cover?song=${safeEncode}`;
        const fallbackEscaped = Icons.fallbackCover.replace(/'/g, "\\'");

        sb.innerHTML = `
            <div class="song-thumb-wrap">
                <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='${fallbackEscaped}'">
                <span class="cache-badge" data-path="${s.path.replace(/"/g, '&quot;')}"></span>
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
                onEnqueue(s, addBtn);
                return;
            }
            onSongClick(s);
        };

        UI.songsContainer.appendChild(sb);
    });
}

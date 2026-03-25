/**
 * Cache UI helpers for library.
 * Creates a cache button + progress bar for a set of songs and connects them
 * to the Service Worker to perform the actual caching.
 */

import { Utils } from '../ui.js';
import { CacheManager } from '../cache.js';

/**
 * Creates a cache button + progress bar widget and appends them to `container`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container     - Where to append the button and progress elements
 * @param {string}      opts.cacheId       - Unique string key for CacheManager.stateMap
 * @param {object[]}    opts.songs         - Array of song objects ({ path, title, artist, size })
 * @param {number}      opts.totalSize     - Sum of file sizes in bytes
 * @param {string}      opts.label         - Button text (e.g. "Cache for offline (~12 MB)")
 * @param {string}      [opts.btnStyle]    - Optional inline style applied to the button
 */
export function createCacheWidget({ container, cacheId, songs, totalSize, label, btnStyle = '' }) {
    const btn = document.createElement('button');
    btn.className = 'cache-playlist-btn';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> ${label}`;
    if (btnStyle) btn.style.cssText = btnStyle;
    container.appendChild(btn);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'cache-progress-wrap';
    progressWrap.innerHTML = `
        <div class="cache-progress-track"><div class="cache-progress-fill"></div></div>
        <div class="cache-progress-label">0 / ${songs.length} songs</div>
    `;
    container.appendChild(progressWrap);

    const fillEl  = progressWrap.querySelector('.cache-progress-fill');
    const labelEl = progressWrap.querySelector('.cache-progress-label');

    // Restore in-progress state if caching is already running
    const existingState = CacheManager.stateMap.get(cacheId);
    if (existingState) {
        existingState.btn     = btn;
        existingState.fillEl  = fillEl;
        existingState.labelEl = labelEl;

        progressWrap.classList.add('visible');
        btn.disabled = true;

        const songsProcessed = Math.floor(existingState.done / 2);
        const pct = Math.round((existingState.done / (songs.length * 2)) * 100) || 0;
        fillEl.style.width  = pct + '%';
        labelEl.textContent = `${songsProcessed} / ${songs.length} songs`;
    } else {
        btn.onclick = async () => {
            if (!confirm(`Cache ${songs.length} track${songs.length > 1 ? 's' : ''} (~${Utils.formatBytes(totalSize)}) for offline playback?`)) return;

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
                alert('Service Worker not active yet — please try again in a moment.');
                return;
            }

            const urls = songs.flatMap(s => [
                '/music/' + Utils.encodePath(s.path),
                '/api/cover?song=' + encodeURIComponent(s.path),
            ]);

            progressWrap.classList.add('visible');
            fillEl.style.width  = '0%';
            labelEl.textContent = `0 / ${songs.length} songs`;

            CacheManager.stateMap.set(cacheId, { done: 0, songCount: songs.length, totalSize, btn, fillEl, labelEl });
            btn.disabled = true;

            sw.postMessage({ action: 'cache_playlist', urls, cacheId });
        };
    }

    CacheManager.checkCacheStatus(songs, btn, totalSize);

    return btn;
}

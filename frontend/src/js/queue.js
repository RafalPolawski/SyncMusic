/**
 * Queue module — renders the play queue with drag-and-drop reordering.
 * Uses DOM API exclusively (no innerHTML with user data) to prevent XSS.
 */

import { UI } from './ui.js';

const removeSVG = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

export function initQueue(socket, player) {
    const { queueContainer, queueCountBadge } = UI;

    let currentQueue = [];

    const renderQueue = (queue) => {
        currentQueue = [...queue]; // local copy for optimistic updates
        if (!queueCountBadge || !queueContainer) return;

        queueCountBadge.innerText = currentQueue.length;
        queueCountBadge.style.display = currentQueue.length > 0 ? 'inline-block' : 'none';

        if (currentQueue.length === 0) {
            queueContainer.innerHTML = '<div class="empty-queue-msg">Queue is empty.</div>';
            return;
        }

        queueContainer.innerHTML = '';

        currentQueue.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'item-btn queue-item';
            row.draggable = true;
            row.dataset.index = index;

            // ── Drag handle ───────────────────────────────────────────────────
            const handle = document.createElement('div');
            handle.className = 'drag-handle';
            handle.title = 'Drag to reorder';
            handle.textContent = '≡';

            // ── Thumbnail ─────────────────────────────────────────────────────
            const img = document.createElement('img');
            img.className = 'song-thumb';
            img.loading = 'lazy';
            img.width = 50;
            img.height = 50;
            img.alt = '';
            img.src = `/api/cover?song=${encodeURIComponent(item.path)}`;

            // ── Track info ────────────────────────────────────────────────────
            const info = document.createElement('div');
            info.className = 'song-info';

            const nameEl = document.createElement('span');
            nameEl.className = 'song-name';
            nameEl.textContent = item.title; // safe

            const artistEl = document.createElement('span');
            artistEl.className = 'song-artist';
            artistEl.textContent = item.artist; // safe

            info.appendChild(nameEl);
            info.appendChild(artistEl);

            // ── Remove button ─────────────────────────────────────────────────
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-queue-btn';
            removeBtn.title = 'Remove from queue';
            removeBtn.innerHTML = removeSVG; // static SVG only

            // ── Assemble ──────────────────────────────────────────────────────
            row.appendChild(handle);
            row.appendChild(img);
            row.appendChild(info);
            row.appendChild(removeBtn);

            // ── Click handling ────────────────────────────────────────────────
            row.onclick = (e) => {
                if (e.target.closest('.remove-queue-btn')) {
                    socket.sendCommand('dequeue', { id: item.id });
                    return;
                }
                if (e.target.closest('.drag-handle')) return;
                socket.sendCommand('load', { song: item.path, folder: 'Queue' });
                socket.sendCommand('dequeue', { id: item.id });
            };

            // ── Drag events ───────────────────────────────────────────────────
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', index);
                setTimeout(() => row.classList.add('dragging'), 0);
            });

            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                queueContainer.querySelectorAll('.queue-item').forEach(c =>
                    c.classList.remove('drag-over-top', 'drag-over-bottom')
                );
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
                row.classList.toggle('drag-over-top', e.clientY < mid);
                row.classList.toggle('drag-over-bottom', e.clientY >= mid);
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('drag-over-top', 'drag-over-bottom');

                const draggedIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (isNaN(draggedIdx)) return;

                let targetIdx = index;
                const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
                if (e.clientY >= mid) targetIdx++;
                if (draggedIdx < targetIdx) targetIdx--;

                if (draggedIdx !== targetIdx) {
                    socket.sendCommand('queue_move', { from: draggedIdx, to: targetIdx });
                    // Optimistic UI update
                    const moved = currentQueue.splice(draggedIdx, 1)[0];
                    currentQueue.splice(targetIdx, 0, moved);
                    renderQueue(currentQueue);
                }
            });

            queueContainer.appendChild(row);
        });
    };

    player.onQueueUpdate(renderQueue);
}

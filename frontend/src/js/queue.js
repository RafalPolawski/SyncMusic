import { Icons } from './ui.js';

export function initQueue(socket, player) {
    const queueContainer = document.getElementById("queueContainer");
    const queueCountBadge = document.getElementById("queueCountBadge");
    
    let currentQueue = [];

    const renderQueue = (queue) => {
        currentQueue = [...queue]; // local copy for optimistic updates
        if (!queueCountBadge || !queueContainer) return;
        queueCountBadge.innerText = currentQueue.length;
        queueCountBadge.style.display = currentQueue.length > 0 ? "inline-block" : "none";

        if (currentQueue.length === 0) {
            queueContainer.innerHTML = '<div class="empty-queue-msg">Queue is empty.</div>';
            return;
        }

        queueContainer.innerHTML = "";
        currentQueue.forEach((item, index) => {
            const qBtn = document.createElement("div");
            qBtn.className = "item-btn queue-item";
            qBtn.draggable = true;
            qBtn.dataset.index = index;
            
            const safeEncode = encodeURIComponent(item.path).replace(/'/g, "%27").replace(/"/g, "%22");
            const thumbUrl = `/api/cover?song=${safeEncode}`;
            const fallbackSvgEscaped = Icons.fallbackCover.replace(/'/g, "\\'");

            qBtn.innerHTML = `
                <div class="drag-handle" title="Drag to reorder">≡</div>
                <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='${fallbackSvgEscaped}'">
                <div class="song-info">
                    <span class="song-name">${item.title}</span>
                    <span class="song-artist">${item.artist}</span>
                </div>
                <button class="remove-queue-btn" title="Remove from queue">
                    <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            `;

            qBtn.onclick = (e) => {
                if (e.target.closest('.remove-queue-btn')) {
                    socket.sendCommand("dequeue", { id: item.id });
                    return;
                }
                if (e.target.closest('.drag-handle')) {
                    return;
                }
                socket.sendCommand("load", { song: item.path, folder: "Queue" });
                socket.sendCommand("dequeue", { id: item.id });
            };

            // Drag and Drop Events
            qBtn.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', index);
                setTimeout(() => qBtn.classList.add('dragging'), 0);
            });

            qBtn.addEventListener('dragend', () => {
                qBtn.classList.remove('dragging');
                Array.from(queueContainer.children).forEach(c => c.classList.remove('drag-over-top', 'drag-over-bottom'));
            });

            qBtn.addEventListener('dragover', (e) => {
                e.preventDefault(); // Necessary to allow dropping
                e.dataTransfer.dropEffect = 'move';
                
                const bounding = qBtn.getBoundingClientRect();
                const offset = e.clientY - bounding.top;
                
                if (offset > bounding.height / 2) {
                    qBtn.classList.remove('drag-over-top');
                    qBtn.classList.add('drag-over-bottom');
                } else {
                    qBtn.classList.remove('drag-over-bottom');
                    qBtn.classList.add('drag-over-top');
                }
            });

            qBtn.addEventListener('dragleave', () => {
                qBtn.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            qBtn.addEventListener('drop', (e) => {
                e.preventDefault();
                qBtn.classList.remove('drag-over-top', 'drag-over-bottom');
                
                const draggedIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (isNaN(draggedIdx)) return;
                
                let targetIdx = index;
                const bounding = qBtn.getBoundingClientRect();
                const offset = e.clientY - bounding.top;
                if (offset > bounding.height / 2) {
                    targetIdx++; // drop below
                }
                
                if (draggedIdx < targetIdx) {
                    targetIdx--;
                }
                
                if (draggedIdx !== targetIdx) {
                    socket.sendCommand("queue_move", { from: draggedIdx, to: targetIdx });
                    
                    // Optimistic UI updates
                    const movedItem = currentQueue.splice(draggedIdx, 1)[0];
                    currentQueue.splice(targetIdx, 0, movedItem);
                    renderQueue(currentQueue);
                }
            });

            queueContainer.appendChild(qBtn);
        });
    };

    player.onQueueUpdate(renderQueue);
}

import { fetchSongsLibrary } from './api.js';
import { SyncWebSocket } from './websocket.js';
import { initPlayer } from './player.js';

/**
 * Main Application Entry Point
 * 
 * Responsible for orchestrating the application's lifecycle on the browser:
 * - Bootstrapping the WebSocket connection.
 * - Initializing the Music Player instance.
 * - Loading media libraries on startup and rendering the folder tree.
 */
document.addEventListener("DOMContentLoaded", () => {
    const socket = new SyncWebSocket();
    const player = initPlayer(socket);

    socket.onMessage((msg) => {
        player.handleSocketMessage(msg);
    });

    const foldersContainer = document.getElementById("foldersContainer");
    const songsContainer = document.getElementById("songsContainer");
    const backBtn = document.getElementById("backBtn");

    fetchSongsLibrary().then(songs => {
        if (!songs || songs.length === 0) return;
        const groups = {};
        songs.forEach(path => {
            const parts = path.split('/');
            const folder = parts.length > 1 ? parts[0] : "Loose Tracks";
            if (!groups[folder]) groups[folder] = [];
            groups[folder].push({ path, name: parts.length > 1 ? parts.slice(1).join('/') : path });
        });

        player.setCacheGroups(groups);

        const showFolders = () => {
            foldersContainer.style.display = "block";
            songsContainer.style.display = "none";
            backBtn.style.display = "none";
            foldersContainer.innerHTML = "";

            for (const f in groups) {
                const b = document.createElement("button");
                b.className = "item-btn folder-btn";
                b.innerText = `📁 ${f} (${groups[f].length})`;
                b.onclick = () => {
                    foldersContainer.style.display = "none";
                    songsContainer.style.display = "block";
                    backBtn.style.display = "block";
                    songsContainer.innerHTML = "";

                    player.setCurrentPlaylistFolder(f);

                    groups[f].forEach(s => {
                        const sb = document.createElement("button");
                        sb.className = "item-btn";

                        const safeEncode = encodeURIComponent(s.path).replace(/'/g, "%27").replace(/"/g, "%22");
                        const thumbUrl = `/api/cover?song=${safeEncode}`;
                        const justName = s.name.replace(/\.[^/.]+$/, "");

                        sb.innerHTML = `
                            <img src="${thumbUrl}" class="song-thumb" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'45\\' height=\\'45\\'><rect width=\\'45\\' height=\\'45\\' fill=\\'%23333\\'/><text x=\\'50%\\' y=\\'50%\\' font-size=\\'20\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\' fill=\\'%23555\\'>🎵</text></svg>'">
                            <div class="song-info">
                                <span class="song-name">${justName}</span>
                                <span class="song-artist">From Library</span>
                            </div>
                        `;

                        sb.onclick = () => {
                            player.setCurrentPlaylistFolder(f);
                            socket.sendCommand("load", { song: s.path, folder: f });
                        };
                        songsContainer.appendChild(sb);
                    });
                };
                foldersContainer.appendChild(b);
            }
        };

        showFolders();
        backBtn.onclick = showFolders;
    });
});

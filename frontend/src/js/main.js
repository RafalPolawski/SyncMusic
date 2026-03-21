import { SyncWebTransport } from './webtransport.js';
import { initUI, UI } from './ui.js';
import { initPlayer, softSyncThreshold, setSyncThreshold } from './player.js';
import { initQueue } from './queue.js';
import { CacheManager } from './cache.js';
import { initLibrary } from './library.js';

/**
 * Main Application Entry Point (Modularized)
 * 
 * Responsible for orchestrating the application's lifecycle on the browser:
 * - Bootstrapping the WebTransport connection.
 * - Initializing the Music Player instance.
 * - Loading media libraries on startup and rendering the folder tree.
 */
document.addEventListener("DOMContentLoaded", () => {
    initUI();

    const savedNick = localStorage.getItem("syncMusicNick");
    if (savedNick && UI.nicknameInput) {
        UI.nicknameInput.value = savedNick;
    }

    CacheManager.initSWListener();

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

    socket.onRttUpdate = (rtt) => {
        if (!UI.rttIndicator) return;
        UI.rttIndicator.style.display = 'inline-flex';
        UI.rttValue.textContent = `${rtt}ms`;

        let color = '#1DB954';
        if (rtt > 50 && rtt <= 150) color = '#f0c040';
        else if (rtt > 150 && rtt <= 300) color = '#e07820';
        else if (rtt > 300) color = '#e03030';

        UI.rttDot.style.background = color;
        UI.rttDot.style.transform = 'scale(1.5)';
        setTimeout(() => { UI.rttDot.style.transform = 'scale(1)'; }, 200);
    };
    if (UI.rttDot) UI.rttDot.style.transition = 'background 0.6s ease, transform 0.2s ease';

    socket.onMessage((msg) => {
        if (msg.action === "presence") {
            if (!UI.usersList) return;
            UI.usersList.innerHTML = ""; // Clear existing
            if (msg.users && msg.users.length > 0) {
                msg.users.forEach(nick => {
                    const tag = document.createElement("div");
                    tag.className = "user-tag";
                    tag.innerText = nick;
                    UI.usersList.appendChild(tag);
                });
            } else {
                UI.usersList.innerHTML = "<span style='color: rgba(255,255,255,0.5); font-size: 14px;'>No listeners yet...</span>";
            }
        } else {
            player.handleSocketMessage(msg);
        }
    });

    if (UI.tabLibrary && UI.tabQueue) {
        UI.tabLibrary.onclick = () => {
            UI.tabLibrary.classList.add("active-tab");
            UI.tabQueue.classList.remove("active-tab");
            UI.libraryView.style.display = "block";
            UI.queueView.style.display = "none";
        };

        UI.tabQueue.onclick = () => {
            UI.tabQueue.classList.add("active-tab");
            UI.tabLibrary.classList.remove("active-tab");
            UI.queueView.style.display = "block";
            UI.libraryView.style.display = "none";
        };
    }

    if (UI.openSettingsBtn) {
        UI.syncThresholdInput.value = softSyncThreshold;
        UI.syncThresholdInput.addEventListener('change', (e) => {
            setSyncThreshold(e.target.value);
        });
        UI.openSettingsBtn.onclick = () => { UI.settingsOverlay.style.display = "flex"; };
        UI.closeSettingsBtn.onclick = () => { UI.settingsOverlay.style.display = "none"; };
    }

    initQueue(socket, player);
    initLibrary(socket, player);
});

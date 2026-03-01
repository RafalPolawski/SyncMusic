// Moduł socketów
export class SyncWebSocket {
    constructor() {
        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        this.socket = new WebSocket(protocol + window.location.host + "/ws");

        this.onMessageCallback = null;

        this.socket.onopen = () => {
            const statusText = document.getElementById("status");
            if (statusText) {
                statusText.innerText = "Connected! 🟢";
                statusText.style.color = "#1DB954";
            }
        };

        this.socket.onmessage = (event) => {
            if (this.onMessageCallback) {
                this.onMessageCallback(JSON.parse(event.data));
            }
        };
    }

    onMessage(callback) {
        this.onMessageCallback = callback;
    }

    sendCommand(action, payload = {}) {
        if (this.socket.readyState === WebSocket.OPEN) {
            const msg = { action, ...payload };
            this.socket.send(JSON.stringify(msg));
        }
    }
}

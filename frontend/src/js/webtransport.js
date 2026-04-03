export class SyncWebTransport {
    constructor() {
        let host = window.location.hostname;
        if (host === 'localhost') {
            host = '127.0.0.1';
        }
        this.baseHttpUrl = window.location.protocol + '//' + window.location.hostname;
        this.wtUrl = `https://${host}:4433/wt`;

        this.onMessageCallback = null;
        this.onReconnect = null;
        this.onRttUpdate = null;
        this.transport = null;
        this.writer = null;
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();

        this.connect();
    }

    async connect() {
        if (typeof WebTransport === 'undefined') {
            const statusText = document.getElementById("status");
            if (statusText) {
                statusText.innerText = "Error: WebTransport requires HTTPS (Secure Context)";
                statusText.style.color = "red";
            }
            console.error("WebTransport API not found! Ensure you are accessing via HTTPS.");
            return;
        }

        try {
            // First fetch the self-signed certificate hash from the Go API
            const response = await fetch('/api/cert-hash?t=' + Date.now());
            const data = await response.json();
            const hexHash = data.hash;

            // Convert hex string to Uint8Array
            const hashBytes = new Uint8Array(hexHash.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

            // Connect using WebTransport, allowing the self-signed certificate
            this.transport = new WebTransport(this.wtUrl, {
                serverCertificateHashes: [{
                    algorithm: 'sha-256',
                    value: hashBytes
                }]
            });

            await this.transport.ready;

            const statusText = document.getElementById("status");
            if (statusText) {
                statusText.innerText = "Connected (UDP HTTP/3)! 🟢";
                statusText.style.color = "#1DB954";
            }

            // In our Go implementation, Go Accepts a bidirectional stream.
            // So we need to CREATE a bidirectional stream.
            const stream = await this.transport.createBidirectionalStream();
            this.writer = stream.writable.getWriter();

            this.serverTimeOffset = 0;
            this.rtt = 0;

            // Read from the stream
            this.readStream(stream.readable);

            // Start pinging for latency measurement
            this.pingInterval = setInterval(() => {
                this.sendCommand("ping", { clientTime: Date.now() });
            }, 3000);
            this.sendCommand("ping", { clientTime: Date.now() });

            // Notify app about reconnection
            if (this.onReconnect) {
                this.onReconnect();
            }

            // Monitor dropping transport proactively 
            this.transport.closed.then(() => {
                console.warn("WebTransport closed normally, reconnecting...");
                this.reconnect();
            }).catch((err) => {
                console.error("WebTransport closed abruptly:", err);
                this.reconnect();
            });

        } catch (error) {
            console.error("WebTransport connection failed:", error);
            this.reconnect();
        }
    }

    reconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;
        
        if (this.transport) {
            try { this.transport.close(); } catch (e) {}
            this.transport = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        setTimeout(() => {
            this.reconnecting = false;
            this.connect();
        }, 2000);
    }

    async readStream(readable) {
        const reader = readable.getReader();
        let buffer = '';

        while (true) {
            try {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += this._decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex);
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.trim().length > 0) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.action === 'pong') {
                                const now = Date.now();
                                const rtt = now - parsed.clientTime;
                                const currentServerTime = parsed.serverTime + (rtt / 2);
                                const newOffset = currentServerTime - now;
                                
                                if (this.rtt === 0 || this.rtt === undefined) {
                                    this.rtt = rtt;
                                    this.serverTimeOffset = newOffset;
                                } else {
                                    this.rtt = (this.rtt * 0.8) + (rtt * 0.2);
                                    this.serverTimeOffset = (this.serverTimeOffset * 0.8) + (newOffset * 0.2);
                                }
                                
                                if (this.onRttUpdate) this.onRttUpdate(this.rtt);
                            } else if (this.onMessageCallback) {
                                this.onMessageCallback(parsed);
                            }
                        } catch (e) {
                            console.error("Failed to parse WT message", e);
                        }
                    }
                }
            } catch (e) {
                console.error("Stream read error:", e);
                this.reconnect();
                break;
            }
        }
    }

    onMessage(callback) {
        this.onMessageCallback = callback;
    }

    getServerTime() {
        return Date.now() + (this.serverTimeOffset || 0);
    }

    getRtt() {
        return this.rtt || 0;
    }

    sendCommand(action, payload = {}) {
        if (this.writer) {
            const msg = { action, ...payload };
            const encoded = this._encoder.encode(JSON.stringify(msg) + "\n");
            this.writer.write(encoded);
        }
    }
}

export class SyncWebTransport {
    constructor() {
        let host = window.location.hostname;
        if (host === 'localhost') {
            host = '127.0.0.1';
        }
        this.baseHttpUrl = window.location.protocol + '//' + window.location.hostname;
        this.wtUrl = `https://${host}:4433/wt`;

        this.onMessageCallback = null;
        this.transport = null;
        this.writer = null;

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

            // Read from the stream
            this.readStream(stream.readable);

        } catch (error) {
            console.error("WebTransport connection failed:", error);
            setTimeout(() => this.connect(), 3000); // Reconnect
        }
    }

    async readStream(readable) {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            try {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex);
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.trim().length > 0 && this.onMessageCallback) {
                        try {
                            this.onMessageCallback(JSON.parse(line));
                        } catch (e) {
                            console.error("Failed to parse WT message", e);
                        }
                    }
                }
            } catch (e) {
                console.error("Stream read error:", e);
                break;
            }
        }
    }

    onMessage(callback) {
        this.onMessageCallback = callback;
    }

    sendCommand(action, payload = {}) {
        if (this.writer) {
            const msg = { action, ...payload };
            const encoded = new TextEncoder().encode(JSON.stringify(msg) + "\n");
            this.writer.write(encoded);
        }
    }
}

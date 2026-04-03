/**
 * SyncWebTransport — WebTransport client with NTP-style clock calibration.
 *
 * Improvements over naive implementation:
 *  - Isolated Web Worker drives ping timer (no main-thread throttling)
 *  - performance.now() for monotonic RTT measurement (no clock-jump jitter)
 *  - RTT outlier rejection via IQR filter (ignores network spikes)
 *  - Separate EMA alphas: RTT fast (α=0.35), offset slow (α=0.15)
 */

export class SyncWebTransport {
    constructor() {
        let host = window.location.hostname;
        if (host === 'localhost') host = '127.0.0.1';

        this.baseHttpUrl = window.location.protocol + '//' + window.location.hostname;
        this.wtUrl = `https://${host}:4433/wt`;

        this.onMessageCallback = null;
        this.onReconnect = null;
        this.onRttUpdate = null;
        this.transport = null;
        this.writer = null;
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();

        // Clock calibration state
        this.serverTimeOffset = 0; // ms: estimatedServerTime - Date.now()
        this.rtt = 0;              // ms: smoothed round-trip time
        this._rttSamples = [];     // raw RTT window for outlier filtering
        this._pendingPings = new Map(); // t0_key → { t0_perf, t0_wall }

        // Web Worker for reliable pinging
        this._timingWorker = null;

        this.connect();
    }

    // ── Connection lifecycle ─────────────────────────────────────────────────

    async connect() {
        if (typeof WebTransport === 'undefined') {
            const s = document.getElementById('status');
            if (s) { s.innerText = 'Error: WebTransport requires HTTPS'; s.style.color = 'red'; }
            console.error('WebTransport not available — ensure HTTPS.');
            return;
        }

        try {
            // Fetch self-signed cert hash — fail fast when offline (4s timeout)
            const response = await fetch('/api/cert-hash?t=' + Date.now(), {
                signal: AbortSignal.timeout(4000),
            });
            if (!response.ok) throw new Error('cert-hash non-OK: ' + response.status);
            const { hash: hexHash } = await response.json();

            const hashBytes = new Uint8Array(
                hexHash.match(/.{1,2}/g).map((b) => parseInt(b, 16))
            );

            this.transport = new WebTransport(this.wtUrl, {
                serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes }],
            });

            await this.transport.ready;

            const statusEl = document.getElementById('status');
            if (statusEl) { statusEl.innerText = 'Connected (UDP HTTP/3) 🟢'; statusEl.style.color = '#1DB954'; }

            const stream = await this.transport.createBidirectionalStream();
            this.writer = stream.writable.getWriter();

            this.serverTimeOffset = 0;
            this.rtt = 0;
            this._rttSamples = [];
            this._pendingPings.clear();
            this.lastPongTime = Date.now();

            this.readStream(stream.readable);
            this._startTimingWorker();

            if (this.onReconnect) this.onReconnect();

            this.transport.closed
                .then(() => { console.warn('WebTransport closed, reconnecting...'); this.reconnect(); })
                .catch((err) => { console.error('WebTransport abrupt close:', err); this.reconnect(); });

        } catch (error) {
            console.error('WebTransport connection failed:', error);
            this.reconnect();
        }
    }

    reconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;

        if (this.onRttUpdate) this.onRttUpdate('OFFLINE');
        const statusEl = document.getElementById('status');
        if (statusEl) { statusEl.innerText = 'OFFLINE ❌'; statusEl.style.color = '#888'; }

        if (this.transport) { try { this.transport.close(); } catch (e) {} this.transport = null; }
        this.writer = null;

        if (this._timingWorker) { this._timingWorker.postMessage({ type: 'stop' }); }

        setTimeout(() => { this.reconnecting = false; this.connect(); }, 2000);
    }

    // ── Ping / clock calibration ─────────────────────────────────────────────

    _startTimingWorker() {
        if (this._timingWorker) {
            this._timingWorker.postMessage({ type: 'stop' });
        }

        try {
            this._timingWorker = new Worker(
                new URL('./timing.worker.js', import.meta.url),
                { type: 'module' }
            );
            this._timingWorker.onmessage = (e) => {
                if (e.data.type === 'tick') this._sendPing();
            };
            this._timingWorker.onerror = (err) => {
                console.warn('Timing worker error, falling back to setInterval:', err);
                this._fallbackInterval = setInterval(() => this._sendPing(), 2000);
            };
            this._timingWorker.postMessage({ type: 'start' });
        } catch (e) {
            // Worker unavailable (e.g., Vite dev module quirk) — fallback
            console.warn('Timing worker unavailable, using setInterval:', e);
            this._fallbackInterval = setInterval(() => this._sendPing(), 2000);
        }
    }

    _sendPing() {
        if (!this.writer) return;
        const key = Math.random().toString(36).slice(2);
        const t0_perf = performance.now();
        const t0_wall = Date.now();
        this._pendingPings.set(key, { t0_perf, t0_wall });
        // Prune stale pings (> 10s) to avoid unbounded growth
        if (this._pendingPings.size > 20) {
            const oldest = this._pendingPings.keys().next().value;
            this._pendingPings.delete(oldest);
        }
        this._writeRaw({ action: 'ping', clientTime: t0_wall, pingKey: key });
    }

    _handlePong(parsed) {
        const t1_perf = performance.now();
        const t1_wall = Date.now();
        this.lastPongTime = t1_wall;

        const pending = this._pendingPings.get(parsed.pingKey);
        if (!pending) return;
        this._pendingPings.delete(parsed.pingKey);

        const rtt = t1_perf - pending.t0_perf; // monotonic, accurate
        const serverTimeOffset = parsed.serverTime + rtt / 2 - t1_wall;

        this._updateCalibration(rtt, serverTimeOffset);
    }

    /** IQR-filtered RTT calibration */
    _updateCalibration(rtt, serverTimeOffset) {
        const WIN = 8;
        this._rttSamples.push({ rtt, offset: serverTimeOffset });
        if (this._rttSamples.length > WIN) this._rttSamples.shift();

        if (this._rttSamples.length < 2) {
            // Bootstrap: accept first sample directly
            this.rtt = rtt;
            this.serverTimeOffset = serverTimeOffset;
            if (this.onRttUpdate) this.onRttUpdate(this.rtt);
            return;
        }

        const rtts = this._rttSamples.map((s) => s.rtt).sort((a, b) => a - b);
        const med = _median(rtts);
        const spread = _iqr(rtts);
        const ceiling = med + Math.max(1.5 * spread, 20); // at least 20ms headroom

        const valid = this._rttSamples.filter((s) => s.rtt <= ceiling && s.rtt > 0);
        if (valid.length === 0) return;

        const avgRtt = valid.reduce((s, x) => s + x.rtt, 0) / valid.length;
        const avgOffset = valid.reduce((s, x) => s + x.offset, 0) / valid.length;

        // EMA: RTT adapts faster (α=0.35), offset more stable (α=0.15)
        if (this.rtt === 0) {
            this.rtt = avgRtt;
            this.serverTimeOffset = avgOffset;
        } else {
            this.rtt = this.rtt * 0.65 + avgRtt * 0.35;
            this.serverTimeOffset = this.serverTimeOffset * 0.85 + avgOffset * 0.15;
        }

        if (this.onRttUpdate) this.onRttUpdate(this.rtt);
    }

    // ── Stream I/O ───────────────────────────────────────────────────────────

    async readStream(readable) {
        const reader = readable.getReader();
        let buffer = '';

        while (true) {
            try {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += this._decoder.decode(value, { stream: true });

                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.action === 'pong') {
                            this._handlePong(msg);
                        } else if (this.onMessageCallback) {
                            this.onMessageCallback(msg);
                        }
                    } catch (e) {
                        console.error('Failed to parse WT message:', e);
                    }
                }
            } catch (e) {
                console.error('Stream read error:', e);
                this.reconnect();
                break;
            }
        }
    }

    _writeRaw(obj) {
        if (!this.writer) return;
        const encoded = this._encoder.encode(JSON.stringify(obj) + '\n');
        this.writer.write(encoded).catch((e) => {
            console.error('WT write failed:', e);
            this.reconnect();
        });
    }

    // ── Public API ───────────────────────────────────────────────────────────

    onMessage(callback) { this.onMessageCallback = callback; }

    getServerTime() { return Date.now() + (this.serverTimeOffset || 0); }
    getRtt() { return this.rtt || 0; }

    sendCommand(action, payload = {}) {
        if (this.writer) {
            this._writeRaw({ action, ...payload });
        } else {
            // OFFLINE MODE: simulate server echo for playback actions
            const allowed = ['load', 'play', 'pause', 'seek', 'shuffle', 'repeat',
                             'enqueue', 'dequeue', 'queue_move'];
            if (!allowed.includes(action)) return;
            const sim = { action, ...payload };
            if (['load', 'play', 'pause', 'seek'].includes(action)) {
                sim.server_ts = Date.now();
            }
            if (this.onMessageCallback) setTimeout(() => this.onMessageCallback(sim), 50);
        }
    }
}

// ── Statistics helpers ────────────────────────────────────────────────────────

function _median(sorted) {
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function _iqr(sorted) {
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    return (q3 ?? sorted[sorted.length - 1]) - (q1 ?? sorted[0]);
}

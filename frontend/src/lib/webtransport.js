import { useNetworkStore } from '../store/useNetworkStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { useQueueStore } from '../store/useQueueStore';

export class SyncWebTransport {
    constructor() {
        let host = window.location.hostname;
        if (host === 'localhost') host = '127.0.0.1';

        this.wtUrl = `https://${host}:4433/wt`;
        
        this.transport = null;
        this.writer = null;
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();

        // Clock calibration state
        this.serverTimeOffset = 0;
        this.rtt = 0;
        this._rttSamples = [];
        this._pendingPings = new Map();

        this.reconnecting = false;
        // Ping loop id
        this._pingInterval = null;

        // Ensure we handle visibilitychange to reconnect if network suspended while screen locked
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                if (!this.writer || this.transport?.closed) {
                    console.log("App resumed and WT is dead, forcing reconnect...");
                    this.reconnect();
                }
            }
        });

        this.connect();
    }

    async connect() {
        if (typeof WebTransport === 'undefined') {
            useNetworkStore.getState().setRtt('OFFLINE');
            return;
        }

        try {
            // Fetch self-signed cert hash
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

            const stream = await this.transport.createBidirectionalStream();
            this.writer = stream.writable.getWriter();

            this.serverTimeOffset = 0;
            this.rtt = 0;
            this._rttSamples = [];
            this._pendingPings.clear();

            this.readStream(stream.readable);
            this.startPinging();

            // Auto-join if user has a nick saved
            const nick = localStorage.getItem('syncMusicNick');
            const room = usePlayerStore.getState().roomId || localStorage.getItem('syncMusicRoom') || 'global';
            if (nick && !usePlayerStore.getState().offlineMode) {
                // If using keycloak, getToken would go here.
                this.sendCommand('join', { nickname: nick, room_id: room });
            }

            this.transport.closed
                .then(() => { this.reconnect(); })
                .catch((err) => { this.reconnect(); });

        } catch (error) {
            console.error('WebTransport connection failed:', error);
            this.reconnect();
        }
    }

    reconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;

        useNetworkStore.getState().setRtt('OFFLINE');

        if (this.transport) { try { this.transport.close(); } catch (e) {} this.transport = null; }
        this.writer = null;
        clearInterval(this._pingInterval);

        setTimeout(() => { this.reconnecting = false; this.connect(); }, 2000);
    }

    startPinging() {
        if (usePlayerStore.getState().offlineMode) return;
        clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => this._sendPing(), 2000);
    }

    _sendPing() {
        if (!this.writer) return;
        const key = Math.random().toString(36).slice(2);
        const t0_perf = performance.now();
        const t0_wall = Date.now();
        this._pendingPings.set(key, { t0_perf, t0_wall });
        
        if (this._pendingPings.size > 20) {
            const oldest = this._pendingPings.keys().next().value;
            this._pendingPings.delete(oldest);
        }
        this._writeRaw({ action: 'ping', clientTime: t0_wall, pingKey: key });
    }

    _handlePong(parsed) {
        const t1_perf = performance.now();
        const t1_wall = Date.now();

        const pending = this._pendingPings.get(parsed.pingKey);
        if (!pending) return;
        this._pendingPings.delete(parsed.pingKey);

        const rtt = t1_perf - pending.t0_perf;
        const serverTimeOffset = parsed.serverTime + rtt / 2 - t1_wall;

        this._updateCalibration(rtt, serverTimeOffset);
    }

    _updateCalibration(rtt, serverTimeOffset) {
        // Fast bootstrap EMA equivalent for React port
        if (this.rtt === 0) {
            this.rtt = rtt;
            this.serverTimeOffset = serverTimeOffset;
        } else {
            this.rtt = this.rtt * 0.65 + rtt * 0.35;
            this.serverTimeOffset = this.serverTimeOffset * 0.85 + serverTimeOffset * 0.15;
        }
        useNetworkStore.getState().setRtt(this.rtt);
    }

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
                        } else {
                            this.dispatchMessage(msg);
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

    getServerTime() { return Date.now() + (this.serverTimeOffset || 0); }
    toServerTime(clientTime) { return clientTime + (this.serverTimeOffset || 0); }

    sendCommand(action, payload = {}) {
        const player = usePlayerStore.getState();
        if (this.writer && !player.offlineMode) {
            if (['load', 'play', 'pause', 'seek'].includes(action)) {
                player.setLastAction();
            }
            this._writeRaw({ action, ...payload });
        } else {
            // OFFLINE MODE: simulate server echo
            const allowed = ['load', 'play', 'pause', 'seek', 'shuffle', 'repeat', 'enqueue', 'dequeue'];
            if (!allowed.includes(action)) return;
            const sim = { action, isSimulated: true, ...payload };
            if (['load', 'play', 'pause', 'seek'].includes(action)) {
                player.setLastAction();
                sim.server_ts = Date.now();
            }
            setTimeout(() => this.dispatchMessage(sim), 50);
        }
    }

    dispatchMessage(msg) {
        const player = usePlayerStore.getState();
        if (player.offlineMode && !msg.isSimulated) {
            return; // Block actual server messages when we explicitly enabled Offline Mode
        }

        // Stale rejection logic: 
        // 1. Explicit actions (load, play, pause, seek) should NEVER be rejected, as they are often our own confirmation.
        // 2. Periodic heartbeats (sync) should be rejected if they were sent by the server BEFORE our last local action.
        if (msg.action === 'sync' && !msg.isSimulated) {
            if (player.lastActionTimestamp > 0 && msg.server_ts) {
                const lastActionInServerTime = this.toServerTime(player.lastActionTimestamp);
                // Allow 200ms grace for network scheduling
                if (msg.server_ts < lastActionInServerTime - 200) {
                    console.log("[SYNC] Rejecting stale periodic heartbeat (Server TS:", msg.server_ts, " < Last Action Server TS:", lastActionInServerTime, ")");
                    return;
                }
            }
        }

        const offsetTime = (msg.server_ts && msg.action !== 'pause') 
            ? msg.time + Math.max(0, (this.getServerTime() - msg.server_ts) / 1000) 
            : msg.time;

        switch(msg.action) {
            case 'sync':
                if (msg.song) {
                    // Only update context if we don't have one, or if it's a sync heartbeat that matches metadata
                    player.setTrack(msg.song, msg.folder, msg.title, msg.artist, false);
                }
                usePlayerStore.setState({
                    syncReceivedTime: Date.now(),
                    syncAudioTime: offsetTime,
                    isPlaying: msg.isPlaying,
                    isShuffle: msg.isShuffle ?? player.isShuffle,
                    isRepeat: msg.isRepeat ?? player.isRepeat,
                    volume: msg.volume ?? player.volume,
                    shuffledQueue: msg.shuffled_sequence ?? player.shuffledQueue
                });
                break;
            case 'load':
                if (msg.song) {
                    const isQueue = msg.is_queue === true;
                    // If it's not from the queue, it's a manual playlist change
                    player.setTrack(msg.song, msg.folder, msg.title, msg.artist, !isQueue);
                }
                const isQueue = msg.is_queue === true;
                usePlayerStore.setState({
                    syncReceivedTime: Date.now(),
                    syncAudioTime: 0,
                    isPlaying: true,
                    shuffledQueue: msg.hasOwnProperty('shuffled_sequence') ? (msg.shuffled_sequence || []) : player.shuffledQueue,
                    // If this is a regular playlist load, update the pivot/context path
                    playbackContextPath: isQueue ? (player.playbackContextPath || msg.song) : msg.song
                });
                break;
            case 'play':
                usePlayerStore.setState({
                    syncReceivedTime: Date.now(),
                    syncAudioTime: offsetTime,
                    isPlaying: true
                });
                break;
            case 'pause':
                usePlayerStore.setState({
                    syncReceivedTime: Date.now(),
                    syncAudioTime: msg.time,
                    isPlaying: false
                });
                break;
            case 'seek':
                usePlayerStore.setState({
                    syncReceivedTime: Date.now(),
                    syncAudioTime: offsetTime,
                    isPlaying: msg.isPlaying !== undefined ? msg.isPlaying : true
                });
                break;
            case 'shuffle':
                usePlayerStore.setState({ 
                    isShuffle: msg.state,
                    shuffledQueue: msg.shuffled_sequence ?? player.shuffledQueue,
                    // If the current song is NOT in the new shuffle, try to keep the old anchor or use current
                    playbackContextPath: player.playbackContextPath || player.currentPath
                });
                break;
            case 'repeat':
                usePlayerStore.setState({ isRepeat: typeof msg.state === 'number' ? msg.state : parseInt(msg.state) });
                break;
            case 'queue_update': {
                const queue = (msg.queue || []).map(item => ({
                    path: item.path,
                    title: item.title || item.path,
                    artist: item.artist || '',
                    folder: item.folder || '',
                    id: item.id
                }));
                useQueueStore.getState().setQueue(queue);
                break;
            }
        }
    }
}

// Singleton export
export const socket = new SyncWebTransport();

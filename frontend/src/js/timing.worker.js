/**
 * Timing Worker — runs in an isolated thread, immune to:
 *  - Main thread GC pauses
 *  - Browser background tab throttling
 *  - Long rendering/layout tasks
 *
 * Strategy:
 *   Burst: 5 pings every 500ms on connect (builds initial EMA quickly)
 *   Steady: 1 ping every 2s thereafter
 */

const BURST_COUNT = 5;
const BURST_INTERVAL_MS = 500;
const STEADY_INTERVAL_MS = 2000;

let steadyTimer = null;

self.onmessage = (e) => {
    if (e.data.type === 'start') {
        startBurst();
    } else if (e.data.type === 'stop') {
        if (steadyTimer) clearInterval(steadyTimer);
        steadyTimer = null;
    }
};

function startBurst() {
    let sent = 0;
    const burst = setInterval(() => {
        self.postMessage({ type: 'tick' });
        sent++;
        if (sent >= BURST_COUNT) {
            clearInterval(burst);
            steadyTimer = setInterval(() => {
                self.postMessage({ type: 'tick' });
            }, STEADY_INTERVAL_MS);
        }
    }, BURST_INTERVAL_MS);
}

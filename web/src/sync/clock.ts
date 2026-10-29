// Estimates the offset between this device's clock and the server clock from
// ping/pong round trips (NTP style).
//
// On a jittery mobile link most samples are distorted by queueing delay, but
// that delay only ever makes a round trip longer. Samples with the smallest
// round-trip time are therefore the most trustworthy, so the estimate is the
// median offset of the fastest few samples in a sliding window.

export interface ClockSample {
  /** Client wall clock when the ping was sent (ms). */
  t0: number;
  /** Server time when the ping arrived (ms). */
  t1: number;
  /** Server time when the pong left (ms). */
  t2: number;
  /** Client wall clock when the pong arrived (ms). */
  t3: number;
}

interface Measured {
  offset: number;
  rtt: number;
  at: number;
}

export interface ClockOptions {
  window: number;
  best: number;
  /** Offset changes below this are slewed instead of applied at once (ms). */
  slewThresholdMs: number;
  slewFactor: number;
}

const defaults: ClockOptions = { window: 24, best: 5, slewThresholdMs: 40, slewFactor: 0.25 };

export class ClockSync {
  private samples: Measured[] = [];
  private current: number | undefined;
  private readonly opts: ClockOptions;

  constructor(opts: Partial<ClockOptions> = {}, initialOffset?: number) {
    this.opts = { ...defaults, ...opts };
    this.current = initialOffset;
  }

  /** Adds a measurement. Returns false when the sample was rejected. */
  add(s: ClockSample): boolean {
    const rtt = s.t3 - s.t0 - (s.t2 - s.t1);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 30_000) return false;
    const offset = (s.t1 - s.t0 + (s.t2 - s.t3)) / 2;
    this.samples.push({ offset, rtt, at: s.t3 });
    if (this.samples.length > this.opts.window) this.samples.shift();
    this.update();
    return true;
  }

  private update(): void {
    const fastest = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, this.opts.best);
    const offsets = fastest.map((m) => m.offset).sort((a, b) => a - b);
    const estimate = offsets[Math.floor(offsets.length / 2)]!;
    if (this.current === undefined || this.samples.length < 3) {
      this.current = estimate;
      return;
    }
    const delta = estimate - this.current;
    if (Math.abs(delta) > this.opts.slewThresholdMs) this.current = estimate;
    else this.current += delta * this.opts.slewFactor;
  }

  /** Forgets all samples, e.g. after the device clock jumped. */
  reset(keepOffset = true): void {
    this.samples = [];
    if (!keepOffset) this.current = undefined;
  }

  /** Server clock minus client clock in ms, if known. */
  get offset(): number | undefined {
    return this.current;
  }

  /** Smallest round trip in the window (ms). */
  get rtt(): number | undefined {
    if (this.samples.length === 0) return undefined;
    return Math.min(...this.samples.map((m) => m.rtt));
  }

  /** Latest round trip (ms), for display. */
  get lastRtt(): number | undefined {
    return this.samples.at(-1)?.rtt;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Upper bound of the offset error: half the best round trip. */
  get accuracy(): number | undefined {
    const r = this.rtt;
    return r === undefined ? undefined : r / 2;
  }

  /** Converts a client wall-clock time to server time. */
  toServer(clientMs: number): number {
    return clientMs + (this.current ?? 0);
  }
}

/**
 * Detects jumps of the device wall clock (NTP corrections, manual changes) by
 * comparing it with the monotonic clock. Returns true when Date.now() moved
 * more than `toleranceMs` relative to performance.now() since the last call.
 */
export class WallClockWatch {
  private base: number;
  constructor(
    private readonly toleranceMs = 500,
    private readonly wall: () => number = () => Date.now(),
    private readonly mono: () => number = () => performance.now(),
  ) {
    this.base = this.wall() - this.mono();
  }

  jumped(): boolean {
    const base = this.wall() - this.mono();
    const moved = Math.abs(base - this.base) > this.toleranceMs;
    this.base = base;
    return moved;
  }
}

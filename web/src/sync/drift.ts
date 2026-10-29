// Keeps a local audio element aligned with the room timeline.
//
// Small offsets are absorbed by nudging playbackRate a few percent (pitch is
// preserved by the browser), which is inaudible. Large offsets, e.g. after
// a stall on a bad connection, are fixed with a seek. Seeks themselves take
// time, so the controller learns a bias it adds to future seek targets.

export interface DriftOptions {
  /** Stop correcting once the drift is below this (ms). */
  deadbandMs: number;
  /** Start rate correction above this drift (ms). */
  correctAboveMs: number;
  /** Seek instead of rate correction above this drift (ms). */
  seekAboveMs: number;
  /** Maximum playbackRate deviation from 1. */
  maxRateDelta: number;
  /** A drift is absorbed over roughly this many seconds. */
  correctionSeconds: number;
  /** Minimum time between two seeks (ms). */
  seekCooldownMs: number;
  /** Delay after a seek before its accuracy is measured (ms). */
  settleMs: number;
  /** Drift samples used for the median filter. */
  samples: number;
  /** Smallest playbackRate change worth applying. */
  minRateStep: number;
}

export const defaultDriftOptions: DriftOptions = {
  deadbandMs: 12,
  correctAboveMs: 30,
  seekAboveMs: 700,
  maxRateDelta: 0.05,
  correctionSeconds: 3,
  seekCooldownMs: 2000,
  settleMs: 700,
  samples: 5,
  minRateStep: 0.002,
};

export type DriftDecision =
  { kind: 'hold' } | { kind: 'rate'; rate: number } | { kind: 'seek'; toMs: number };

const MAX_BIAS_MS = 600;

export class DriftController {
  readonly opts: DriftOptions;
  rate = 1;
  /** Learned offset added to seek targets (ms). */
  seekBiasMs = 0;
  private correcting = false;
  private window: number[] = [];
  private lastSeekAt = -Infinity;
  private seekMeasured = true;

  constructor(opts: Partial<DriftOptions> = {}, seekBiasMs = 0) {
    this.opts = { ...defaultDriftOptions, ...opts };
    this.seekBiasMs = seekBiasMs;
  }

  /** Forgets samples, e.g. after loading another track. */
  reset(): void {
    this.window = [];
    this.correcting = false;
    this.rate = 1;
  }

  /** Smoothed drift (ms, positive = ahead of the room), if known. */
  get driftMs(): number | undefined {
    if (this.window.length === 0) return undefined;
    const sorted = [...this.window].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * Feeds one observation: the element position and the room position at
   * the same instant (both ms). Returns what the player should do.
   */
  observe(now: number, actualMs: number, targetMs: number): DriftDecision {
    const o = this.opts;
    const raw = actualMs - targetMs;
    const sinceSeek = now - this.lastSeekAt;
    if (sinceSeek < o.settleMs) return { kind: 'hold' };

    this.window.push(raw);
    if (this.window.length > o.samples) this.window.shift();
    const drift = this.driftMs!;

    if (!this.seekMeasured) {
      // Residual error right after a seek tells how late seeks land.
      this.seekMeasured = true;
      if (Math.abs(raw) < o.seekAboveMs) {
        this.seekBiasMs = clamp(this.seekBiasMs - raw * 0.6, -MAX_BIAS_MS, MAX_BIAS_MS);
      }
    }

    if (Math.abs(drift) > o.seekAboveMs || Math.abs(raw) > o.seekAboveMs * 3) {
      if (sinceSeek < o.seekCooldownMs) return { kind: 'hold' };
      this.lastSeekAt = now;
      this.seekMeasured = false;
      this.window = [];
      this.correcting = false;
      this.rate = 1;
      return { kind: 'seek', toMs: Math.max(0, targetMs + this.seekBiasMs) };
    }

    if (!this.correcting && Math.abs(drift) > o.correctAboveMs) this.correcting = true;
    if (this.correcting && Math.abs(drift) < o.deadbandMs) this.correcting = false;

    const desired = this.correcting
      ? 1 - clamp(drift / (o.correctionSeconds * 1000), -o.maxRateDelta, o.maxRateDelta)
      : 1;
    if (desired === 1 ? this.rate !== 1 : Math.abs(desired - this.rate) >= o.minRateStep) {
      this.rate = round(desired);
      return { kind: 'rate', rate: this.rate };
    }
    return { kind: 'hold' };
  }

  /** Marks an externally triggered seek (e.g. when a track starts). */
  noteSeek(now: number): void {
    this.lastSeekAt = now;
    this.seekMeasured = false;
    this.window = [];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

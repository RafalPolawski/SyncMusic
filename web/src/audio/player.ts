// Drives a single HTMLAudioElement so that it follows the room timeline.
//
// Every tick the player asks "what should be audible right now?" (a Target
// computed from the room state and the synchronised clock) and nudges the
// element towards it: loading tracks, parking armed starts and firing them
// on time, and keeping drift in check with the DriftController.
//
// Play latency (time between play() and sound) differs per phone; the drift
// controller learns it, and the player starts that much early.

import { DriftController } from '../sync/drift';
import type { Target } from '../sync/timeline';

export interface MediaLike extends EventTarget {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly duration: number;
  playbackRate: number;
  volume: number;
  preload: string;
  preservesPitch?: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export interface Source {
  url: string;
  cached: boolean;
  release?: () => void;
}

export interface PlayerState {
  trackId: string;
  ready: boolean;
  buffering: boolean;
  audible: boolean;
  driftMs: number | undefined;
  personalPause: boolean;
  needsGesture: boolean;
  unavailable: boolean;
}

export interface PlayerDeps {
  element: MediaLike;
  /** Resolves a playable source; undefined when the track cannot be played now. */
  resolve(trackId: string, opts: { bypassCache: boolean }): Promise<Source | undefined>;
  /** Server clock (ms). */
  now(): number;
  /** Desired playback at server time `now`. */
  target(now: number): Target | undefined;
  /** Extra lead to compensate output latency, e.g. Bluetooth (ms). */
  latencyMs(): number;
  onChange?(s: PlayerState): void;
  /** The element was paused by the system (call, headphones unplugged…). */
  onExternalPause?(): void;
  /** The element reached the end of the track. */
  onEnded?(trackId: string): void;
  drift?: DriftController;
  tickMs?: number;
}

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const PAUSED_TOLERANCE_MS = 250;
const PARK_TOLERANCE_MS = 30;
/** How long a pending end-of-track 'pause' event is waited for. */
const END_PAUSE_GRACE_MS = 1000;

export class AudioPlayer {
  readonly drift: DriftController;
  private readonly d: PlayerDeps;
  private readonly el: MediaLike;
  private trackId = '';
  private source: Source | undefined;
  private loadGen = 0;
  private loading = false;
  private unavailable = false;
  private bypassCache = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private startAt = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private selfPause = 0;
  /** The element ended and its 'pause' event has been dispatched. */
  private endPauseSeen = false;
  /** When the player moved on from an ended track before its 'pause' event. */
  private endPauseQueuedAt = -Infinity;
  private buffering = false;
  private needsGesture = false;
  private personalPause = false;
  private disposed = false;
  private last = '';

  constructor(deps: PlayerDeps) {
    this.d = deps;
    this.el = deps.element;
    this.drift = deps.drift ?? new DriftController();
    this.el.preload = 'auto';
    if ('preservesPitch' in this.el) this.el.preservesPitch = true;
    for (const ev of ['loadedmetadata', 'canplay', 'canplaythrough', 'seeked', 'playing']) {
      this.el.addEventListener(ev, this.onReadyish);
    }
    this.el.addEventListener('waiting', this.onWaiting);
    this.el.addEventListener('stalled', this.onWaiting);
    this.el.addEventListener('pause', this.onPause);
    this.el.addEventListener('ended', this.onEnded);
    this.el.addEventListener('error', this.onError);
    this.interval = setInterval(() => this.tick(), deps.tickMs ?? 200);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.interval);
    clearTimeout(this.startTimer);
    clearTimeout(this.retryTimer);
    this.el.removeEventListener('pause', this.onPause);
    this.pauseEl();
    this.source?.release?.();
  }

  /** Element position (ms), for diagnostics. */
  get elementMs(): number {
    return this.el.currentTime * 1000;
  }

  get elementPaused(): boolean {
    return this.el.paused;
  }

  get state(): PlayerState {
    const el = this.el;
    return {
      trackId: this.trackId,
      ready: !!this.trackId && !this.loading && !this.unavailable && el.readyState >= HAVE_FUTURE_DATA,
      buffering: this.loading || this.buffering,
      audible: !el.paused && !this.buffering,
      driftMs: el.paused ? undefined : this.drift.driftMs,
      personalPause: this.personalPause,
      needsGesture: this.needsGesture,
      unavailable: this.unavailable,
    };
  }

  setPersonalPause(paused: boolean): void {
    this.personalPause = paused;
    this.tick();
  }

  setVolume(v: number): void {
    this.el.volume = Math.min(1, Math.max(0, v));
  }

  /** Must be called from a user gesture: allows the browser to play. */
  unlock(): void {
    this.needsGesture = false;
    const t = this.d.target(this.d.now());
    if (this.el.src && t?.playing && !this.personalPause) {
      this.playEl();
    } else if (this.el.src) {
      // Prime the element so later programmatic play() calls are allowed.
      this.el
        .play()
        .then(() => this.pauseEl())
        .catch(() => undefined);
    }
    this.tick();
  }

  /** Re-evaluates the target immediately (call after room state changes). */
  tick = (): void => {
    if (this.disposed) return;
    const now = this.d.now();
    const t = this.d.target(now);
    if (!t || !t.trackId) {
      this.clearStart();
      this.pauseEl();
      this.publish();
      return;
    }
    if (t.trackId !== this.trackId) {
      void this.load(t.trackId);
      this.publish();
      return;
    }
    if (this.loading || this.unavailable) {
      this.publish();
      return;
    }
    const el = this.el;
    const latency = this.d.latencyMs();
    if (!t.playing || this.personalPause) {
      this.clearStart();
      this.pauseEl();
      this.setRate(1);
      if (
        !this.personalPause &&
        el.readyState >= HAVE_METADATA &&
        Math.abs(el.currentTime * 1000 - t.positionMs) > PAUSED_TOLERANCE_MS
      ) {
        this.seekEl(t.positionMs);
      }
      this.publish();
      return;
    }
    const bias = Math.max(0, this.drift.seekBiasMs);
    if (t.startsInMs > bias + 5) {
      // Armed start: park on the start position, fire just in time.
      this.pauseEl();
      if (
        el.readyState >= HAVE_METADATA &&
        Math.abs(el.currentTime * 1000 - t.positionMs) > PARK_TOLERANCE_MS
      ) {
        this.seekEl(t.positionMs);
      }
      this.scheduleStart(now + t.startsInMs - bias);
      this.publish();
      return;
    }
    this.clearStart();
    // Where the room is right now, extrapolated through a pending start.
    const roomPos = t.positionMs - t.startsInMs + latency;
    if (t.durationMs > 0 && roomPos >= t.durationMs - 50) {
      this.publish(); // the track is ending; the next one takes over
      return;
    }
    if (el.paused) {
      if (el.readyState < HAVE_FUTURE_DATA) {
        this.buffering = true;
        this.publish();
        return;
      }
      this.seekEl(Math.max(0, roomPos + this.drift.seekBiasMs));
      this.drift.noteSeek(now);
      this.playEl();
      this.publish();
      return;
    }
    const decision = this.drift.observe(now, el.currentTime * 1000, roomPos);
    if (decision.kind === 'seek') this.seekEl(decision.toMs);
    else if (decision.kind === 'rate') this.setRate(decision.rate);
    this.publish();
  };

  private scheduleStart(at: number): void {
    if (this.startTimer && Math.abs(at - this.startAt) < 15) return;
    clearTimeout(this.startTimer);
    this.startAt = at;
    this.startTimer = setTimeout(
      () => {
        this.startTimer = undefined;
        this.tick();
      },
      Math.max(0, at - this.d.now()),
    );
  }

  private clearStart(): void {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
  }

  private async load(trackId: string): Promise<void> {
    this.leaveEnded();
    const gen = ++this.loadGen;
    clearTimeout(this.retryTimer);
    this.clearStart();
    this.trackId = trackId;
    this.loading = true;
    this.unavailable = false;
    this.buffering = false;
    this.drift.reset();
    this.pauseEl();
    let src: Source | undefined;
    try {
      src = await this.d.resolve(trackId, { bypassCache: this.bypassCache });
    } catch {
      src = undefined;
    }
    if (gen !== this.loadGen || this.disposed) {
      src?.release?.();
      return;
    }
    this.bypassCache = false;
    const previous = this.source;
    this.source = src;
    if (!src) {
      this.loading = false;
      this.unavailable = true;
      this.el.removeAttribute('src');
      this.el.load();
      previous?.release?.();
      // Try again later: the track may get downloaded or the network may return.
      this.retryTimer = setTimeout(() => {
        if (this.trackId === trackId) void this.load(trackId);
      }, 5000);
      this.publish();
      return;
    }
    this.el.src = src.url;
    this.el.load();
    previous?.release?.();
    this.loading = false;
    this.tick();
  }

  private playEl(): void {
    this.leaveEnded();
    this.el.play().then(
      () => {
        this.needsGesture = false;
        this.publish();
      },
      (err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          this.needsGesture = true;
          this.publish();
        }
      },
    );
  }

  private pauseEl(): void {
    if (this.el.paused) return;
    this.selfPause++;
    this.el.pause();
  }

  private seekEl(ms: number): void {
    this.leaveEnded();
    try {
      this.el.currentTime = Math.max(0, ms) / 1000;
    } catch {
      // not seekable yet
    }
  }

  private setRate(rate: number): void {
    if (this.el.playbackRate !== rate) this.el.playbackRate = rate;
  }

  private publish(): void {
    if (!this.d.onChange) return;
    const s = this.state;
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.d.onChange(s);
  }

  private onReadyish = () => {
    this.buffering = false;
    this.tick();
  };

  private onWaiting = () => {
    this.buffering = true;
    this.publish();
  };

  /**
   * Reaching the end of a track pauses the element at once, but browsers
   * dispatch the 'pause' event later. Called before the player changes an
   * ended element (seek, play, new source): if that event is still pending,
   * it would arrive looking like a pause by the system, so it is expected.
   */
  private leaveEnded(): void {
    if (!this.el.ended) return;
    if (!this.endPauseSeen) this.endPauseQueuedAt = this.d.now();
    this.endPauseSeen = false;
  }

  private onPause = () => {
    if (this.selfPause > 0) {
      this.selfPause--;
      return;
    }
    if (this.el.ended) {
      this.endPauseSeen = true;
      return;
    }
    if (this.d.now() - this.endPauseQueuedAt < END_PAUSE_GRACE_MS) {
      // The late pause of a track the player already moved on from.
      this.endPauseQueuedAt = -Infinity;
      return;
    }
    // Paused by the OS or the browser (incoming call, headphones removed).
    this.personalPause = true;
    this.d.onExternalPause?.();
    this.publish();
  };

  private onEnded = () => {
    if (this.trackId) this.d.onEnded?.(this.trackId);
  };

  private onError = () => {
    if (!this.trackId || this.loading) return;
    const trackId = this.trackId;
    // A corrupt cached copy falls back to the network; otherwise retry later.
    if (this.source?.cached) this.bypassCache = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        if (this.trackId === trackId) void this.load(trackId);
      },
      this.bypassCache ? 0 : 3000,
    );
    this.buffering = true;
    this.publish();
  };
}

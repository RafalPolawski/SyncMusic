import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer, type MediaLike, type PlayerState, type Source } from './player';
import type { Target } from '../sync/timeline';

class FakeMedia extends EventTarget implements MediaLike {
  src = '';
  private time = 0;
  paused = true;
  ended = false;
  readyState = 0;
  duration = 300;
  playbackRate = 1;
  volume = 1;
  preload = '';
  preservesPitch = true;
  blockPlay = false;
  plays = 0;
  loads = 0;

  play(): Promise<void> {
    if (this.blockPlay) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    this.plays++;
    this.paused = false;
    queueMicrotask(() => this.dispatchEvent(new Event('playing')));
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  }
  get currentTime(): number {
    return this.time;
  }
  set currentTime(v: number) {
    this.time = v;
    if (v < this.duration) this.ended = false;
  }
  load(): void {
    this.loads++;
    this.readyState = 0;
    this.ended = false;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  ready(): void {
    this.readyState = 4;
    this.dispatchEvent(new Event('canplay'));
  }
  /** Simulates the system pausing playback. */
  systemPause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  advance(ms: number): void {
    if (!this.paused) this.currentTime += (ms * this.playbackRate) / 1000;
  }
  /**
   * Plays to the end like Chromium: paused and ended change at once, the
   * 'pause' and 'ended' events are dispatched later (call the result).
   */
  reachEnd(): () => void {
    this.time = this.duration;
    this.paused = true;
    this.ended = true;
    return () => {
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
    };
  }
}

let now = 100_000;
let target: Target | undefined;
let el: FakeMedia;
let resolveImpl: (id: string, o: { bypassCache: boolean }) => Promise<Source | undefined>;
let states: PlayerState[];
let player: AudioPlayer;
const released: string[] = [];

function make(extra: Partial<ConstructorParameters<typeof AudioPlayer>[0]> = {}) {
  el = new FakeMedia();
  states = [];
  player = new AudioPlayer({
    element: el,
    resolve: (id, o) => resolveImpl(id, o),
    now: () => now,
    target: () => target,
    latencyMs: () => 0,
    onChange: (s) => states.push(s),
    tickMs: 200,
    ...extra,
  });
  return player;
}

function playing(trackId: string, positionMs: number, startsInMs = 0): Target {
  return { trackId, positionMs, playing: true, startsInMs, durationMs: 200_000 };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 100_000;
  released.length = 0;
  resolveImpl = async (id) => ({ url: `blob:${id}`, cached: true, release: () => released.push(id) });
});

afterEach(() => {
  player?.dispose();
  vi.useRealTimers();
});

describe('AudioPlayer', () => {
  it('loads the target track and starts at the room position', async () => {
    target = playing('a', 5000);
    make();
    player.tick();
    await flush();
    expect(el.src).toBe('blob:a');
    expect(el.paused).toBe(true);
    expect(player.state.ready).toBe(false);
    el.ready();
    await flush();
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeCloseTo(5, 2);
    expect(player.state.ready).toBe(true);
    expect(player.state.audible).toBe(true);
  });

  it('parks an armed start and fires it on time', async () => {
    const anchor = now + 1500;
    make({
      target: (n) => ({
        trackId: 'a',
        positionMs: 0,
        playing: true,
        startsInMs: Math.max(0, anchor - n),
        durationMs: 200_000,
      }),
    });
    player.tick();
    await flush();
    el.ready();
    await flush();
    expect(el.paused).toBe(true);
    expect(el.currentTime).toBe(0);
    now += 1400;
    await vi.advanceTimersByTimeAsync(1400);
    expect(el.paused).toBe(true);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(el.paused).toBe(false);
    expect(el.plays).toBe(1);
  });

  it('starts early by the learned play latency', async () => {
    target = playing('a', 0, 1000);
    make();
    player.drift.seekBiasMs = 100;
    player.tick();
    await flush();
    el.ready();
    await flush();
    expect(el.paused).toBe(true);
    // At 100ms before the anchor the start fires (startsIn <= bias).
    now += 900;
    target = playing('a', 0, 100);
    await vi.advanceTimersByTimeAsync(905);
    expect(el.paused).toBe(false);
    // It positions where the room will be once audio is actually heard.
    expect(el.currentTime * 1000).toBeCloseTo(0, 0);
  });

  it('pauses with the room without reporting an external pause', async () => {
    const external = vi.fn();
    target = playing('a', 1000);
    make({ onExternalPause: external });
    player.tick();
    await flush();
    el.ready();
    await flush();
    target = { trackId: 'a', positionMs: 1200, playing: false, startsInMs: 0, durationMs: 200_000 };
    player.tick();
    await flush();
    expect(el.paused).toBe(true);
    expect(external).not.toHaveBeenCalled();
    expect(player.state.personalPause).toBe(false);
  });

  it('treats a system pause as a personal pause', async () => {
    const external = vi.fn();
    target = playing('a', 1000);
    make({ onExternalPause: external });
    player.tick();
    await flush();
    el.ready();
    await flush();
    el.systemPause();
    expect(external).toHaveBeenCalledOnce();
    expect(player.state.personalPause).toBe(true);
    player.tick();
    expect(el.paused).toBe(true); // stays paused although the room plays
    player.setPersonalPause(false);
    await flush();
    expect(el.paused).toBe(false);
  });

  describe('end of a track', () => {
    async function playingNearEnd(): Promise<void> {
      target = playing('a', 199_700);
      make();
      player.tick();
      await flush();
      el.ready();
      await flush();
      expect(el.paused).toBe(false);
    }

    it('is not a personal pause when the event arrives while ended', async () => {
      await playingNearEnd();
      el.reachEnd()();
      expect(player.state.personalPause).toBe(false);
    });

    it('is not a personal pause when the player resumed before the event arrived', async () => {
      // The phone ran ahead: the element ended before the room did.
      await playingNearEnd();
      const deliver = el.reachEnd();
      target = playing('a', 199_800);
      player.tick(); // seeks back to the room position and plays on
      await flush();
      expect(el.ended).toBe(false);
      deliver();
      expect(player.state.personalPause).toBe(false);
      player.tick();
      expect(el.paused).toBe(false);
    });

    it('is not a personal pause when the next track loaded before the event arrived', async () => {
      await playingNearEnd();
      const deliver = el.reachEnd();
      target = playing('b', 0);
      player.tick();
      await flush();
      expect(el.src).toBe('blob:b');
      deliver();
      expect(player.state.personalPause).toBe(false);
      el.ready();
      await flush();
      expect(el.paused).toBe(false);
    });

    it('still notices a later system pause', async () => {
      await playingNearEnd();
      el.reachEnd()(); // delivered while ended
      target = playing('b', 0);
      player.tick();
      await flush();
      el.ready();
      await flush();
      now += 5000;
      el.systemPause();
      expect(player.state.personalPause).toBe(true);
    });

    it('does not swallow a system pause when an end produced no event', async () => {
      await playingNearEnd();
      el.reachEnd(); // never delivered
      target = playing('b', 0);
      player.tick();
      await flush();
      el.ready();
      await flush();
      now += 2000;
      el.systemPause();
      expect(player.state.personalPause).toBe(true);
    });
  });

  it('asks for a gesture when autoplay is blocked', async () => {
    target = playing('a', 0);
    make();
    el.blockPlay = true;
    player.tick();
    await flush();
    el.ready();
    await flush();
    expect(player.state.needsGesture).toBe(true);
    el.blockPlay = false;
    player.unlock();
    await flush();
    expect(el.paused).toBe(false);
    expect(player.state.needsGesture).toBe(false);
  });

  it('reports unavailable tracks and retries later', async () => {
    let available = false;
    resolveImpl = async (id) => (available ? { url: `net:${id}`, cached: false } : undefined);
    target = playing('a', 0);
    make();
    player.tick();
    await flush();
    expect(player.state.unavailable).toBe(true);
    available = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(el.src).toBe('net:a');
    expect(player.state.unavailable).toBe(false);
  });

  it('seeks when far off and adjusts rate when slightly off', async () => {
    target = playing('a', 10_000);
    make();
    player.tick();
    await flush();
    el.ready();
    await flush();
    expect(el.paused).toBe(false);
    // Let the post-start settle window pass while staying in sync.
    for (let i = 0; i < 5; i++) {
      now += 200;
      el.advance(200);
      target = playing('a', (target as Target).positionMs + 200);
      player.tick();
    }
    // The element stalls for 3 s.
    now += 3000;
    target = playing('a', (target as Target).positionMs + 3000);
    player.tick();
    expect(Math.abs(el.currentTime * 1000 - target.positionMs)).toBeLessThan(1);
    // Later a small drift appears: rate correction, no seek.
    for (let i = 0; i < 6; i++) {
      now += 200;
      el.advance(200);
      target = playing('a', target.positionMs + 200);
      player.tick();
    }
    el.currentTime += 0.08;
    for (let i = 0; i < 6; i++) {
      now += 200;
      el.advance(200);
      target = playing('a', target.positionMs + 200);
      player.tick();
    }
    expect(el.playbackRate).toBeLessThan(1);
  });

  it('switches tracks and releases the previous source', async () => {
    target = playing('a', 0);
    make();
    player.tick();
    await flush();
    el.ready();
    await flush();
    target = playing('b', 0);
    player.tick();
    await flush();
    expect(el.src).toBe('blob:b');
    expect(released).toEqual(['a']);
    expect(player.state.trackId).toBe('b');
  });

  it('falls back to the network when a cached file is broken', async () => {
    const calls: boolean[] = [];
    resolveImpl = async (id, o) => {
      calls.push(o.bypassCache);
      return o.bypassCache ? { url: `net:${id}`, cached: false } : { url: `blob:${id}`, cached: true };
    };
    target = playing('a', 0);
    make();
    player.tick();
    await flush();
    el.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(calls).toEqual([false, true]);
    expect(el.src).toBe('net:a');
  });

  it('stops when nothing should play and reports end of track', async () => {
    const ended = vi.fn();
    target = playing('a', 0);
    make({ onEnded: ended });
    player.tick();
    await flush();
    el.ready();
    await flush();
    el.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledWith('a');
    target = undefined;
    player.tick();
    await flush();
    expect(el.paused).toBe(true);
    player.setVolume(2);
    expect(el.volume).toBe(1);
  });

  it('compensates output latency', async () => {
    target = playing('a', 10_000);
    make({ latencyMs: () => 200 });
    player.tick();
    await flush();
    el.ready();
    await flush();
    expect(el.currentTime * 1000).toBeCloseTo(10_200, 0);
  });
});

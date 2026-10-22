import { describe, expect, it } from 'vitest';
import { ClockSync, WallClockWatch } from './clock';

/** Simulates a ping over a link with the given one-way delays. */
function sample(trueOffset: number, sendAt: number, up: number, down: number, serverProcessing = 1) {
  const t0 = sendAt;
  const t1 = sendAt + up + trueOffset;
  const t2 = t1 + serverProcessing;
  const t3 = t2 - trueOffset + down;
  return { t0, t1, t2, t3 };
}

/** Deterministic pseudo random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('ClockSync', () => {
  it('computes offset and rtt from a symmetric sample', () => {
    const c = new ClockSync();
    expect(c.offset).toBeUndefined();
    c.add(sample(5000, 1000, 20, 20));
    expect(c.offset).toBeCloseTo(5000, 6);
    expect(c.rtt).toBe(40);
    expect(c.accuracy).toBe(20);
    expect(c.toServer(100)).toBeCloseTo(5100, 6);
  });

  it('stays accurate on a jittery link with heavy queueing spikes', () => {
    const rand = rng(42);
    const c = new ClockSync();
    const trueOffset = -123456;
    for (let i = 0; i < 200; i++) {
      const base = 30;
      // Most packets suffer 0-400 ms of random queueing, asymmetric.
      const up = base + (rand() < 0.7 ? rand() * 400 : rand() * 10);
      const down = base + (rand() < 0.7 ? rand() * 400 : rand() * 10);
      c.add(sample(trueOffset, i * 2000, up, down));
    }
    expect(Math.abs(c.offset! - trueOffset)).toBeLessThan(10);
  });

  it('rejects impossible samples', () => {
    const c = new ClockSync();
    expect(c.add({ t0: 0, t1: 0, t2: 0, t3: 50 })).toBe(true);
    expect(c.add({ t0: 0, t1: 0, t2: 100, t3: 50 })).toBe(false); // negative rtt
    expect(c.add({ t0: 0, t1: 0, t2: 0, t3: 60_000 })).toBe(false); // absurd rtt
    expect(c.add({ t0: NaN, t1: 0, t2: 0, t3: 1 })).toBe(false);
    expect(c.sampleCount).toBe(1);
  });

  it('slews small corrections and jumps on large ones', () => {
    const c = new ClockSync({ slewThresholdMs: 40, slewFactor: 0.5 });
    for (let i = 0; i < 5; i++) c.add(sample(1000, i * 100, 10, 10));
    expect(c.offset).toBeCloseTo(1000, 6);
    // Gradual drift of the true offset by 20 ms: slewed, not jumped.
    const w = new ClockSync({ slewThresholdMs: 40, slewFactor: 0.5, window: 3, best: 1 });
    for (let i = 0; i < 3; i++) w.add(sample(1000, i * 100, 10, 10));
    w.add(sample(1020, 500, 5, 5));
    expect(w.offset).toBeCloseTo(1010, 6);
    // A 5 s jump (device clock changed) is applied immediately.
    for (let i = 0; i < 3; i++) w.add(sample(6000, 1000 + i * 100, 1, 1));
    expect(w.offset).toBeCloseTo(6000, 6);
  });

  it('keeps the window bounded and can reset', () => {
    const c = new ClockSync({ window: 4 });
    for (let i = 0; i < 10; i++) c.add(sample(0, i, 5, 5));
    expect(c.sampleCount).toBe(4);
    c.reset();
    expect(c.sampleCount).toBe(0);
    expect(c.offset).toBeCloseTo(0, 6);
    expect(c.rtt).toBeUndefined();
    c.reset(false);
    expect(c.offset).toBeUndefined();
  });

  it('starts from a persisted offset', () => {
    const c = new ClockSync({}, 777);
    expect(c.offset).toBe(777);
    expect(c.toServer(0)).toBe(777);
  });
});

describe('WallClockWatch', () => {
  it('detects wall clock jumps', () => {
    let wall = 1_000_000;
    let mono = 0;
    const w = new WallClockWatch(
      500,
      () => wall,
      () => mono,
    );
    wall += 1000;
    mono += 1000;
    expect(w.jumped()).toBe(false);
    wall += 60_000;
    mono += 1000;
    expect(w.jumped()).toBe(true);
    expect(w.jumped()).toBe(false);
  });
});

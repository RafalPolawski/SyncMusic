import { describe, expect, it } from 'vitest';
import { DriftController } from './drift';

/**
 * Simulates an audio element that plays at controller.rate, with an optional
 * seek latency, against a room clock advancing in real time.
 */
function simulate(opts: {
  initialDriftMs: number;
  seekLatencyMs?: number;
  durationMs: number;
  stepMs?: number;
  jitterMs?: number;
}) {
  const c = new DriftController();
  const step = opts.stepMs ?? 200;
  let target = 10_000;
  let actual = target + opts.initialDriftMs;
  let seeks = 0;
  let maxRateDelta = 0;
  let seed = 1;
  const jitter = () => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) * 2 - 1) * (opts.jitterMs ?? 0);
  };
  for (let now = 0; now < opts.durationMs; now += step) {
    target += step;
    actual += step * c.rate;
    const d = c.observe(now, actual + jitter(), target);
    if (d.kind === 'seek') {
      seeks++;
      actual = d.toMs - (opts.seekLatencyMs ?? 0);
    }
    maxRateDelta = Math.max(maxRateDelta, Math.abs(c.rate - 1));
  }
  return { drift: actual - target, seeks, maxRateDelta, controller: c };
}

describe('DriftController', () => {
  it('absorbs small drift with rate changes only', () => {
    const r = simulate({ initialDriftMs: 150, durationMs: 15_000 });
    expect(r.seeks).toBe(0);
    expect(Math.abs(r.drift)).toBeLessThan(15);
    expect(r.maxRateDelta).toBeGreaterThan(0);
    expect(r.maxRateDelta).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(r.controller.rate).toBe(1);
  });

  it('corrects when behind as well as ahead', () => {
    const r = simulate({ initialDriftMs: -250, durationMs: 20_000 });
    expect(r.seeks).toBe(0);
    expect(Math.abs(r.drift)).toBeLessThan(15);
  });

  it('seeks on large drift', () => {
    const r = simulate({ initialDriftMs: 5000, durationMs: 10_000 });
    expect(r.seeks).toBe(1);
    expect(Math.abs(r.drift)).toBeLessThan(15);
  });

  it('learns seek latency', () => {
    const r = simulate({ initialDriftMs: -3000, seekLatencyMs: 250, durationMs: 30_000 });
    expect(r.seeks).toBe(1);
    expect(r.controller.seekBiasMs).toBeGreaterThan(100);
    expect(Math.abs(r.drift)).toBeLessThan(20);
  });

  it('ignores tiny drift and survives measurement jitter', () => {
    const r = simulate({ initialDriftMs: 5, durationMs: 10_000, jitterMs: 8 });
    expect(r.seeks).toBe(0);
    expect(r.maxRateDelta).toBeLessThan(0.01);
  });

  it('does not seek repeatedly during cooldown', () => {
    const c = new DriftController({ seekCooldownMs: 2000, settleMs: 0 });
    expect(c.observe(0, 5000, 0).kind).toBe('seek');
    expect(c.observe(100, 5000, 100).kind).toBe('hold');
    expect(c.observe(2500, 9000, 2500).kind).toBe('seek');
  });

  it('holds right after a seek and reports smoothed drift', () => {
    const c = new DriftController();
    expect(c.driftMs).toBeUndefined();
    c.noteSeek(0);
    expect(c.observe(100, 1000, 0)).toEqual({ kind: 'hold' });
    c.observe(1000, 1050, 1000);
    expect(c.driftMs).toBe(50);
    c.reset();
    expect(c.driftMs).toBeUndefined();
    expect(c.rate).toBe(1);
  });
});

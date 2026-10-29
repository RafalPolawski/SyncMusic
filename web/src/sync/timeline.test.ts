import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyRoomState, type Playback, type RoomState } from './protocol';
import { normalize, positionAt, target, upcoming, type Catalog } from './timeline';

interface Fixtures {
  catalog: Record<string, number>;
  positionAt: { name: string; playback: Playback; now: number; expect: number }[];
  normalize: {
    name: string;
    state: Partial<RoomState>;
    now: number;
    expect: { changed: boolean; playback: Playback; contextIndex: number; queue: string[] };
  }[];
  upcoming: { name: string; state: Partial<RoomState>; n: number; expect: string[] }[];
}

// The same contract file is used by the Go tests in internal/room.
const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../testdata/sync/timeline.json'), 'utf8'),
) as Fixtures;

const catalog: Catalog = (id) => fixtures.catalog[id];

function stateFrom(partial: Partial<RoomState>): RoomState {
  const base = emptyRoomState();
  return {
    ...base,
    ...partial,
    playback: { ...base.playback, ...partial.playback },
    context: { ...base.context, ...partial.context },
    queue: partial.queue ?? [],
  };
}

function stripEmpty(p: Playback): Playback {
  const out = { ...p };
  if (!out.entryId) delete out.entryId;
  return out;
}

describe('shared timeline fixtures', () => {
  it.each(fixtures.positionAt)('positionAt: $name', (c) => {
    expect(positionAt(c.playback, c.now)).toBe(c.expect);
  });

  it.each(fixtures.normalize)('normalize: $name', (c) => {
    const input = stateFrom(c.state);
    const snapshot = JSON.stringify(input);
    const { state, changed } = normalize(input, c.now, catalog);
    expect(changed).toBe(c.expect.changed);
    expect(stripEmpty(state.playback)).toEqual(stripEmpty(c.expect.playback));
    expect(state.contextIndex).toBe(c.expect.contextIndex);
    expect(state.queue.map((q) => q.id)).toEqual(c.expect.queue);
    expect(JSON.stringify(input)).toBe(snapshot); // input untouched
    expect(normalize(state, c.now, catalog).changed).toBe(false);
  });

  it.each(fixtures.upcoming)('upcoming: $name', (c) => {
    const s = stateFrom(c.state);
    const snapshot = JSON.stringify(s);
    expect(upcoming(s, c.n, catalog)).toEqual(c.expect);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('normalize', () => {
  it('stepping in small increments equals one jump', () => {
    for (const c of fixtures.normalize) {
      let stepped = stateFrom(c.state);
      for (let now = stepped.playback.anchorMs; now <= c.now; now += 333) {
        stepped = normalize(stepped, now, catalog).state;
      }
      stepped = normalize(stepped, c.now, catalog).state;
      const jumped = normalize(stateFrom(c.state), c.now, catalog).state;
      expect(stepped.playback).toEqual(jumped.playback);
      expect(stepped.contextIndex).toBe(jumped.contextIndex);
    }
  });
});

describe('target', () => {
  it('reports an armed start', () => {
    const s = stateFrom({
      playback: { trackId: 'a', positionMs: 0, anchorMs: 5000, playing: true, durationMs: 10000 },
    });
    expect(target(s, 4000)).toEqual({
      trackId: 'a',
      positionMs: 0,
      playing: true,
      startsInMs: 1000,
      durationMs: 10000,
    });
    expect(target(s, 6000).startsInMs).toBe(0);
    expect(target(s, 6000).positionMs).toBe(1000);
  });

  it('carries the queue entry id', () => {
    const s = stateFrom({
      playback: { trackId: 'a', entryId: 'q1', positionMs: 0, anchorMs: 0, playing: false, durationMs: 1 },
    });
    expect(target(s, 0).entryId).toBe('q1');
  });
});

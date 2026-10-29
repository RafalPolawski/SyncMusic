// Client copy of the room timeline rules (internal/room/timeline.go). Both
// implementations are checked against testdata/sync/timeline.json; keep them
// in lockstep. These functions let every phone keep playing the same thing
// while it is offline, including automatic advances to the next track.

import type { Playback, RoomState } from './protocol';

/** Resolves track durations; undefined means the track is unavailable. */
export type Catalog = (trackId: string) => number | undefined;

const MAX_ADVANCE_STEPS = 10000;

export function positionAt(p: Playback, now: number): number {
  if (!p.playing || now <= p.anchorMs) return p.positionMs;
  const pos = p.positionMs + (now - p.anchorMs);
  if (p.durationMs > 0 && pos > p.durationMs) return p.durationMs;
  return pos;
}

export function endsAt(p: Playback): number | undefined {
  if (!p.playing || !p.trackId || p.durationMs <= 0) return undefined;
  return p.anchorMs + Math.max(0, p.durationMs - p.positionMs);
}

interface Item {
  trackId: string;
  entryId?: string;
}

function contextTrack(s: RoomState, orderIdx: number): string {
  return s.context.tracks[s.context.order[orderIdx]!]!;
}

/** Mutates s: removes and returns the next item to play. */
function takeNext(s: RoomState, wrap: boolean, cat: Catalog): Item | undefined {
  while (s.queue.length > 0) {
    const e = s.queue[0]!;
    s.queue = s.queue.slice(1);
    s.queueVersion++;
    if (cat(e.trackId) !== undefined) return { trackId: e.trackId, entryId: e.id };
  }
  const n = s.context.order.length;
  let idx = s.contextIndex;
  for (let i = 0; i < n; i++) {
    idx++;
    if (idx >= n) {
      if (!wrap) return undefined;
      idx = 0;
    }
    const id = contextTrack(s, idx);
    if (cat(id) !== undefined) {
      s.contextIndex = idx;
      return { trackId: id };
    }
  }
  return undefined;
}

function startItem(s: RoomState, it: Item, anchor: number, cat: Catalog): void {
  const p: Playback = {
    trackId: it.trackId,
    positionMs: 0,
    anchorMs: anchor,
    playing: true,
    durationMs: cat(it.trackId) ?? 0,
  };
  if (it.entryId) p.entryId = it.entryId;
  s.playback = p;
}

function stopAtEnd(s: RoomState, at: number, cat: Catalog): void {
  if (s.context.order.length > 0) {
    s.contextIndex = 0;
    const id = contextTrack(s, 0);
    s.playback = { trackId: id, positionMs: 0, anchorMs: at, playing: false, durationMs: cat(id) ?? 0 };
    return;
  }
  const { entryId: _drop, ...rest } = s.playback;
  s.playback = { ...rest, positionMs: 0, anchorMs: at, playing: false };
}

function advanceAuto(s: RoomState, at: number, cat: Catalog): void {
  if (s.repeat === 'one') {
    s.playback = { ...s.playback, positionMs: 0, anchorMs: at };
    return;
  }
  const next = takeNext(s, s.repeat === 'all', cat);
  if (!next) stopAtEnd(s, at, cat);
  else startItem(s, next, at, cat);
}

function clone(s: RoomState): RoomState {
  return {
    ...s,
    playback: { ...s.playback },
    queue: s.queue.slice(),
    context: { ...s.context, tracks: s.context.tracks.slice(), order: s.context.order.slice() },
    hold: s.hold ? { ...s.hold } : s.hold,
  };
}

/**
 * Advances the timeline to server time `now`, returning a new state (the
 * input is not modified) and whether anything changed.
 */
export function normalize(
  input: RoomState,
  now: number,
  cat: Catalog,
): { state: RoomState; changed: boolean } {
  let s = input;
  let changed = false;
  for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
    const end = endsAt(s.playback);
    if (end === undefined || now < end) break;
    if (!changed) s = clone(s);
    advanceAuto(s, end, cat);
    changed = true;
  }
  return { state: s, changed };
}

/** Up to n track ids that will play after the current one. */
export function upcoming(input: RoomState, n: number, cat: Catalog): string[] {
  if (n <= 0) return [];
  if (input.repeat === 'one' && input.playback.trackId) return Array<string>(n).fill(input.playback.trackId);
  const s = clone(input);
  const out: string[] = [];
  while (out.length < n) {
    const it = takeNext(s, s.repeat === 'all', cat);
    if (!it) break;
    out.push(it.trackId);
  }
  return out;
}

/** What a player should be doing at a given moment. */
export interface Target {
  trackId: string;
  entryId?: string;
  positionMs: number;
  playing: boolean;
  /** > 0 while an armed start is pending: milliseconds until it starts. */
  startsInMs: number;
  durationMs: number;
}

export function target(s: RoomState, now: number): Target {
  const p = s.playback;
  const t: Target = {
    trackId: p.trackId,
    positionMs: positionAt(p, now),
    playing: p.playing,
    startsInMs: p.playing && now < p.anchorMs ? p.anchorMs - now : 0,
    durationMs: p.durationMs,
  };
  if (p.entryId) t.entryId = p.entryId;
  return t;
}

import { useSyncExternalStore } from 'react';
import { getEngine } from '../engine';
import { useRoom, useUI } from '../store/room';
import { positionAt } from '../sync/timeline';

export interface PositionInfo {
  trackId: string;
  entryId?: string;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  startsInMs: number;
}

function read(): PositionInfo {
  const e = getEngine();
  const now = e.serverNow();
  const s = e.stateAt(now);
  const p = s.playback;
  return {
    trackId: p.trackId,
    ...(p.entryId ? { entryId: p.entryId } : {}),
    positionMs: Math.round(positionAt(p, now)),
    durationMs: p.durationMs,
    playing: p.playing,
    startsInMs: p.playing && now < p.anchorMs ? Math.round(p.anchorMs - now) : 0,
  };
}

// One shared ticker for every component showing the playback position.
let snapshot: PositionInfo | undefined;
const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;
let unsubscribeRoom: (() => void) | undefined;

function refresh(): void {
  const next = read();
  if (
    snapshot &&
    next.trackId === snapshot.trackId &&
    next.entryId === snapshot.entryId &&
    next.positionMs === snapshot.positionMs &&
    next.durationMs === snapshot.durationMs &&
    next.playing === snapshot.playing &&
    next.startsInMs === snapshot.startsInMs
  ) {
    return;
  }
  snapshot = next;
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    ticker = setInterval(refresh, 250);
    unsubscribeRoom = useRoom.subscribe(refresh);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      clearInterval(ticker);
      unsubscribeRoom?.();
    }
  };
}

function getSnapshot(): PositionInfo {
  snapshot ??= read();
  return snapshot;
}

/** Current playback position, refreshed four times per second. */
export function usePosition(): PositionInfo {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Re-renders when download state changes; returns the downloader. */
export function useDownloads() {
  useUI((s) => s.downloadsVersion);
  return getEngine().downloader;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

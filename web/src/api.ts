// REST client for the SyncMusic server.

export interface LibraryTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  folder: string;
  file: string;
  trackNo?: number;
  discNo?: number;
  durationMs: number;
  codec?: string;
  bitrate?: number;
  size: number;
  cover?: boolean;
  rev: string;
}

export interface LibraryFolder {
  path: string;
  name: string;
  parent: string;
  trackIds: string[];
  coverTrackId?: string;
}

export interface LibraryPlaylist {
  id: string;
  name: string;
  path: string;
  trackIds: string[];
}

export interface LibraryData {
  version: string;
  tracks: LibraryTrack[];
  folders: LibraryFolder[];
  playlists: LibraryPlaylist[];
}

export interface SessionInfo {
  authRequired: boolean;
  authenticated: boolean;
  serverVersion: string;
  transcoding: boolean;
}

export interface ScanStatus {
  scanning: boolean;
  processed: number;
  total: number;
  lastScanAt?: string;
  lastError?: string;
  tracks: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  listeners: string[];
  trackId?: string;
  playing: boolean;
}

export type Quality = 'low' | 'medium' | 'high' | 'original';
export type AudioFormat = 'opus' | 'aac';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code || `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let code = '';
    try {
      code = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  session: () => request<SessionInfo>('/api/session', { cache: 'no-store' }),
  login: (password: string) => request<void>('/api/auth/login', json({ password })),
  logout: () => request<void>('/api/auth/logout', json({})),
  rescan: () => request<ScanStatus>('/api/library/rescan', json({})),
  scanStatus: () => request<ScanStatus>('/api/library/status'),
  rooms: () => request<RoomSummary[]>('/api/rooms'),

  /** Fetches the library; resolves to undefined when unchanged (304). */
  async library(etag?: string): Promise<{ data: LibraryData; etag: string } | undefined> {
    const res = await fetch('/api/library', {
      credentials: 'same-origin',
      headers: etag ? { 'If-None-Match': etag } : {},
      cache: 'no-store',
    });
    if (res.status === 304) return undefined;
    if (!res.ok) throw new ApiError(res.status, '');
    return { data: (await res.json()) as LibraryData, etag: res.headers.get('ETag') ?? '' };
  },
};

export function audioUrl(t: { id: string; rev: string }, p: { format: string; quality: string }): string {
  return `/api/tracks/${encodeURIComponent(t.id)}/audio?f=${p.format}&q=${p.quality}&v=${t.rev}`;
}

export function coverUrl(trackId: string, rev: string, size: 128 | 512 = 128): string {
  return `/api/tracks/${encodeURIComponent(trackId)}/cover?s=${size}&v=${rev}`;
}

/** Picks the best transcoding target this browser can decode. */
export function preferredFormat(el?: HTMLMediaElement): AudioFormat {
  const probe = el ?? (typeof document !== 'undefined' ? document.createElement('audio') : undefined);
  if (!probe?.canPlayType) return 'aac';
  return probe.canPlayType('audio/ogg; codecs="opus"') ? 'opus' : 'aac';
}

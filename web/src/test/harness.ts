// Shared fakes for engine and component tests: a scriptable WebSocket, a
// controllable media element, a routed fetch and a small sample library.

import { vi } from 'vitest';
import type { LibraryData } from '../api';
import type { MediaLike } from '../audio/player';
import { Engine, setEngineForTests } from '../engine';
import { createOfflineDB, MemoryAudioStore, resetOfflineDBForTests } from '../offline/db';
import { buildIndex, useLibrary } from '../store/library';
import { initialPlayer, useRoom, useUI } from '../store/room';
import { defaultSettings, useSettings } from '../store/settings';
import type { SocketLike } from '../sync/connection';
import { emptyRoomState, type Command, type StateMessage } from '../sync/protocol';

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  ofType(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
  /** Commands sent so far, without the envelope. */
  commands(): Command[] {
    return this.ofType('cmd').map((m) => m.cmd as Command);
  }
  lastCommand(): Command | undefined {
    return this.commands().at(-1);
  }
}

export class FakeMedia extends EventTarget implements MediaLike {
  src = '';
  currentTime = 0;
  paused = true;
  ended = false;
  readyState = 0;
  duration = 300;
  playbackRate = 1;
  volume = 1;
  preload = '';
  preservesPitch = true;
  play(): Promise<void> {
    this.paused = false;
    queueMicrotask(() => this.dispatchEvent(new Event('playing')));
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  }
  load(): void {
    this.readyState = 0;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  ready(): void {
    this.readyState = 4;
    this.dispatchEvent(new Event('canplay'));
  }
}

export const sampleLibrary: LibraryData = {
  version: 'lib-1',
  tracks: [
    {
      id: 'a',
      title: 'Rozgrzewka',
      artist: 'Bass Lab',
      folder: 'Siłownia',
      file: '01.mp3',
      durationMs: 200_000,
      size: 100,
      rev: 'ra',
      cover: true,
    },
    {
      id: 'b',
      title: 'Przysiady',
      artist: 'Iron Pulse',
      folder: 'Siłownia',
      file: '02.mp3',
      durationMs: 180_000,
      size: 100,
      rev: 'rb',
    },
    {
      id: 'c',
      title: 'Martwy ciąg',
      artist: 'Bass Lab',
      folder: 'Siłownia',
      file: '03.mp3',
      durationMs: 150_000,
      size: 100,
      rev: 'rc',
    },
    {
      id: 'd',
      title: 'Noc',
      artist: 'Soft Waves',
      folder: 'Chill/Wieczór',
      file: 'noc.flac',
      durationMs: 240_000,
      size: 100,
      rev: 'rd',
    },
    {
      id: 'e',
      title: 'Luźny kawałek',
      artist: 'Solo',
      folder: '',
      file: 'luzny.mp3',
      durationMs: 120_000,
      size: 100,
      rev: 're',
    },
  ],
  folders: [
    { path: '', name: '', parent: '', trackIds: ['e'] },
    { path: 'Chill', name: 'Chill', parent: '', trackIds: [] },
    { path: 'Chill/Wieczór', name: 'Wieczór', parent: 'Chill', trackIds: ['d'] },
    { path: 'Siłownia', name: 'Siłownia', parent: '', trackIds: ['a', 'b', 'c'], coverTrackId: 'a' },
  ],
  playlists: [{ id: 'p1', name: 'Bieganie', path: 'bieganie.m3u', trackIds: ['c', 'e'] }],
};

export interface Route {
  status?: number;
  json?: unknown;
  body?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
}

/** Installs a fetch mock answering by path; unknown paths return 404. */
export function mockFetch(routes: Record<string, Route | ((init: RequestInit | undefined) => Route)>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(url.pathname + url.search);
    const entry = routes[url.pathname + url.search] ?? routes[url.pathname];
    const r =
      typeof entry === 'function' ? entry(init) : (entry ?? { status: 404, json: { error: 'not_found' } });
    const status = r.status ?? 200;
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), {
        status,
        headers: { 'Content-Type': 'application/json', ...r.headers },
      });
    }
    const body = r.body ?? new Uint8Array(0);
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: { 'Content-Type': 'audio/ogg', 'Content-Length': String(body.byteLength), ...r.headers },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function stateMessage(version: number, extra: Partial<StateMessage> = {}): StateMessage {
  const base = emptyRoomState();
  return {
    type: 'state',
    version,
    serverTime: Date.now(),
    playback: base.playback,
    contextIndex: base.contextIndex,
    shuffle: false,
    repeat: 'off',
    waitForAll: false,
    queueVersion: 0,
    queue: [],
    contextVersion: 1,
    context: base.context,
    ...extra,
  };
}

export const welcome = {
  type: 'welcome',
  protocol: 1,
  serverTime: 0,
  room: { id: 'gym', name: 'Gym' },
  clientId: 'test-client',
  libraryVersion: 'lib-1',
  timing: { startDelayMs: 1500, resumeDelayMs: 400 },
  serverVersion: 'test',
};

export interface Harness {
  engine: Engine;
  media: FakeMedia;
  audio: MemoryAudioStore;
  sockets: FakeSocket[];
  /** Opens the newest socket and completes the handshake. */
  connect(): FakeSocket;
}

/** Resets all stores and creates an engine wired to fakes. */
export async function createHarness(): Promise<Harness> {
  await resetOfflineDBForTests();
  localStorage.clear();
  useSettings.setState({ ...defaultSettings, name: 'Ala', room: 'gym' });
  useLibrary.setState({
    index: buildIndex(sampleLibrary),
    etag: '"lib-1"',
    loading: false,
    error: undefined,
  });
  useRoom.setState({
    status: 'idle',
    state: emptyRoomState(),
    welcome: undefined,
    members: [],
    waiting: [],
    rttMs: undefined,
    clockAccuracyMs: undefined,
    halted: undefined,
    player: initialPlayer,
  });
  useUI.setState({ toasts: [], downloadsVersion: 0, updateAvailable: false });
  const sockets: FakeSocket[] = [];
  const media = new FakeMedia();
  const audio = new MemoryAudioStore();
  const engine = new Engine({
    element: media,
    db: createOfflineDB(audio),
    wsUrl: 'ws://test/api/ws',
    socket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
  });
  setEngineForTests(engine);
  await engine.downloader.whenReady();
  return {
    engine,
    media,
    audio,
    sockets,
    connect() {
      const s = sockets.at(-1)!;
      s.open();
      s.receive(welcome);
      return s;
    },
  };
}

export function disposeHarness(h: Harness | undefined): void {
  if (!h) return;
  h.engine.stop();
  h.engine.player.dispose();
  h.engine.downloader.dispose();
  setEngineForTests(undefined);
}

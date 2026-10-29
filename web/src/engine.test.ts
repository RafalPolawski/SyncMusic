import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import { useLibrary } from './store/library';
import { useRoom, useUI } from './store/room';
import { useSettings } from './store/settings';
import type { PlayContext, Playback } from './sync/protocol';
import {
  createHarness,
  disposeHarness,
  mockFetch,
  sampleLibrary,
  stateMessage,
  type FakeSocket,
  type Harness,
  type Route,
} from './test/harness';

const gym: PlayContext = {
  kind: 'folder',
  id: 'Siłownia',
  name: 'Siłownia',
  tracks: ['a', 'b', 'c'],
  order: [0, 1, 2],
};

function playback(p: Partial<Playback>): Playback {
  return { trackId: 'a', positionMs: 0, anchorMs: Date.now(), playing: false, durationMs: 200_000, ...p };
}

const audio: Route = { body: new Uint8Array(64).fill(1) };
const audioRoutes = {
  '/api/tracks/a/audio': audio,
  '/api/tracks/b/audio': audio,
  '/api/tracks/c/audio': audio,
  '/api/tracks/d/audio': audio,
  '/api/tracks/e/audio': audio,
};

let h: Harness | undefined;
let net: ReturnType<typeof mockFetch>;

beforeEach(() => {
  net = mockFetch(audioRoutes);
});

afterEach(() => {
  disposeHarness(h);
  h = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts an engine, completes the handshake and sends a first state. */
async function online(p?: Partial<Playback>, extra: Parameters<typeof stateMessage>[1] = {}) {
  h = await createHarness();
  await h.engine.start();
  const ws = h.connect();
  if (p) ws.receive(stateMessage(1, { playback: playback(p), context: gym, contextIndex: 0, ...extra }));
  return { h, ws };
}

function ack(ws: FakeSocket, ok = true, error?: { code: string; message: string }) {
  const id = ws.ofType('cmd').at(-1)!.id;
  ws.receive({ type: 'ack', id, ok, version: 2, ...(error ? { error } : {}) });
}

describe('Engine following the room', () => {
  it('streams the current track and downloads only what comes next', async () => {
    const { h } = await online({ trackId: 'a', playing: true, anchorMs: Date.now() - 1000 });
    await vi.waitFor(() => expect(h.media.src).toBe('/api/tracks/a/audio?f=aac&q=medium&v=ra'));
    expect(useRoom.getState().status).toBe('online');
    expect(useRoom.getState().state.playback.trackId).toBe('a');

    await vi.waitFor(() => expect(h.engine.downloader.downloadedIds().sort()).toEqual(['b', 'c']));
    expect(net.calls.some((c) => c.startsWith('/api/tracks/a/'))).toBe(false);
  });

  it('starts playing once the track is buffered and reports its status', async () => {
    const { h, ws } = await online({ trackId: 'a', playing: true, anchorMs: Date.now() - 1000 });
    await vi.waitFor(() => expect(h.media.src).not.toBe(''));
    h.media.ready();
    await vi.waitFor(() => expect(useRoom.getState().player.audible).toBe(true));
    expect(h.media.paused).toBe(false);
    expect(h.media.currentTime).toBeGreaterThan(0.9);
    await vi.waitFor(() =>
      expect(ws.ofType('status').at(-1)).toMatchObject({ trackId: 'a', ready: true, playing: true }),
    );
  });

  it('plays from the offline copy when the track is downloaded', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:offline-a', revokeObjectURL: () => {} }),
    );
    h = await createHarness();
    await h.engine.downloader.pin('test', [{ id: 'a', rev: 'ra' }]);
    await vi.waitFor(() => expect(h!.engine.downloader.isDownloaded('a')).toBe(true));
    await h.engine.start();
    h.connect().receive(stateMessage(1, { playback: playback({ trackId: 'a' }), context: gym }));
    await vi.waitFor(() => expect(h!.media.src).toBe('blob:offline-a'));
  });

  it('follows a paused room to the paused position', async () => {
    const { h } = await online({ trackId: 'b', positionMs: 42_000 });
    await vi.waitFor(() => expect(h.media.src).toContain('/tracks/b/'));
    h.media.ready();
    await vi.waitFor(() => expect(h.media.currentTime).toBe(42));
    expect(h.media.paused).toBe(true);
  });

  it('asks the server to advance when the track length is unknown', async () => {
    const { h, ws } = await online({ trackId: 'a', playing: true, durationMs: 0 });
    await vi.waitFor(() => expect(h.media.src).not.toBe(''));
    h.media.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(ws.lastCommand()).toEqual({ op: 'ended', trackId: 'a' }));
  });

  it('continues from the saved snapshot after a restart without network', async () => {
    const first = await online({ trackId: 'c', positionMs: 5000 });
    await vi.waitFor(async () => expect(await first.h.engine.db.getKV('room:gym')).toBeDefined(), {
      timeout: 4000,
    });
    disposeHarness(first.h);

    const second = await createHarness();
    h = second;
    // createHarness wipes the database; put the snapshot back as it was saved.
    await second.engine.db.setKV('room:gym', { ...first.h.engine.conn.state });
    await second.engine.start();
    expect(useRoom.getState().state.playback).toMatchObject({ trackId: 'c', positionMs: 5000 });
    expect(useRoom.getState().status).not.toBe('online');
  });

  it('refreshes the library when the server announces a change', async () => {
    const changed = { ...sampleLibrary, version: 'lib-2' };
    mockFetch({ ...audioRoutes, '/api/library': { json: changed, headers: { ETag: '"lib-2"' } } });
    const { ws } = await online();
    ws.receive({ type: 'library', version: 'lib-2' });
    await vi.waitFor(() => expect(useLibrary.getState().index?.data.version).toBe('lib-2'));
    expect(useUI.getState().toasts.map((x) => x.text)).toContain(t('libraryUpdated'));
  });

  it('catches up with a newer library silently after connecting', async () => {
    mockFetch({
      '/api/library': { json: { ...sampleLibrary, version: 'lib-3' }, headers: { ETag: '"lib-3"' } },
    });
    h = await createHarness();
    await h.engine.start();
    h.sockets.at(-1)!.open();
    h.sockets.at(-1)!.receive({
      type: 'welcome',
      protocol: 1,
      serverTime: 0,
      room: { id: 'gym', name: 'Gym' },
      clientId: 'x',
      libraryVersion: 'lib-3',
      timing: { startDelayMs: 1500, resumeDelayMs: 400 },
      serverVersion: 't',
    });
    await vi.waitFor(() => expect(useLibrary.getState().etag).toBe('"lib-3"'));
    expect(useUI.getState().toasts).toEqual([]);
  });

  it('publishes presence and clock quality', async () => {
    const { ws } = await online();
    ws.receive({
      type: 'presence',
      members: [
        {
          clientId: 'x',
          name: 'Ola',
          connected: true,
          ready: true,
          buffering: false,
          playing: true,
          lastSeen: 1,
        },
      ],
      waiting: ['x'],
    });
    expect(useRoom.getState().members.map((m) => m.name)).toEqual(['Ola']);
    expect(useRoom.getState().waiting).toEqual(['x']);

    const ping = ws.ofType('ping')[0] as { id: number; t0: number };
    ws.receive({ type: 'pong', id: ping.id, t0: ping.t0, t1: ping.t0, t2: ping.t0 });
    expect(useRoom.getState().rttMs).toBeDefined();
  });
});

describe('Engine commands', () => {
  it('pauses the room at the current position, optimistically', async () => {
    const { ws } = await online({ trackId: 'a', playing: true, anchorMs: Date.now() - 5000 });
    const done = h!.engine.pause();
    const cmd = ws.lastCommand() as { op: string; positionMs: number };
    expect(cmd.op).toBe('pause');
    expect(cmd.positionMs).toBeGreaterThanOrEqual(5000);
    expect(cmd.positionMs).toBeLessThan(5500);
    expect(useRoom.getState().state.playback.playing).toBe(false);
    ack(ws);
    await done;
  });

  it('resumes the room with a short delay so every phone can start together', async () => {
    const { ws } = await online({ trackId: 'a', positionMs: 1000 });
    const before = Date.now();
    const done = h!.engine.play();
    expect(ws.lastCommand()).toEqual({ op: 'play' });
    const p = useRoom.getState().state.playback;
    expect(p.playing).toBe(true);
    expect(p.anchorMs).toBeGreaterThanOrEqual(before + 400);
    ack(ws);
    await done;
  });

  it('rolls back and explains a rejected command', async () => {
    const { ws } = await online({ trackId: 'a', positionMs: 1000 });
    const done = h!.engine.play();
    expect(useRoom.getState().state.playback.playing).toBe(true);
    ack(ws, false, { code: 'invalid', message: 'nope' });
    await done;
    expect(useRoom.getState().state.playback.playing).toBe(false);
    expect(useUI.getState().toasts.map((x) => x.text)).toContain(t('commandFailed', { reason: 'nope' }));
  });

  it('seeks optimistically', async () => {
    const { ws } = await online({ trackId: 'a' });
    void h!.engine.seek(42_400.4);
    expect(ws.lastCommand()).toEqual({ op: 'seek', positionMs: 42_400 });
    expect(useRoom.getState().state.playback.positionMs).toBe(42_400);
  });

  it('toggles between the room playing and paused', async () => {
    const { ws } = await online({ trackId: 'a', playing: true, anchorMs: Date.now() - 1000 });
    void h!.engine.togglePlay();
    expect(ws.lastCommand()?.op).toBe('pause');
    ack(ws);
    ws.receive(stateMessage(2, { playback: playback({ positionMs: 1000 }) }));
    void h!.engine.togglePlay();
    expect(ws.lastCommand()?.op).toBe('play');
  });

  it('sends queue, mode and navigation commands', async () => {
    const { ws } = await online({ trackId: 'a' });
    const e = h!.engine;
    void e.next();
    void e.prev();
    void e.jump(2);
    void e.playEntry('q1');
    void e.queueAdd(['d', 'e'], true);
    void e.queueRemove('q1');
    void e.queueMove('q2', 0);
    void e.queueClear();
    void e.setShuffle(true);
    void e.setRepeat('one');
    void e.setWaitForAll(false);
    void e.playContext({ kind: 'folder', id: 'Siłownia', name: 'Siłownia', tracks: ['a', 'b', 'c'] }, 1);
    expect(ws.commands()).toEqual([
      { op: 'next' },
      { op: 'prev' },
      { op: 'jump', index: 2 },
      { op: 'playEntry', entryId: 'q1' },
      { op: 'queueAdd', trackIds: ['d', 'e'], next: true },
      { op: 'queueRemove', entryId: 'q1' },
      { op: 'queueMove', entryId: 'q2', toIndex: 0 },
      { op: 'queueClear' },
      { op: 'shuffle', on: true },
      { op: 'repeat', mode: 'one' },
      { op: 'waitForAll', on: false },
      {
        op: 'playContext',
        context: { kind: 'folder', id: 'Siłownia', name: 'Siłownia', tracks: ['a', 'b', 'c'] },
        startIndex: 1,
      },
    ]);
  });

  it('replays a command issued during a short disconnect', async () => {
    const { ws } = await online({ trackId: 'a' });
    ws.drop();
    expect(useRoom.getState().status).toBe('offline');
    const done = h!.engine.next();
    expect(ws.ofType('cmd')).toHaveLength(0);
    await vi.waitFor(() => expect(h!.sockets.length).toBe(2), { timeout: 2000 });
    const again = h!.connect();
    expect(again.lastCommand()).toEqual({ op: 'next' });
    ack(again);
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it('pauses only this phone once the connection is really gone', async () => {
    const { ws } = await online({ trackId: 'a', playing: true });
    ws.drop();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000);

    await h!.engine.pause();
    expect(useRoom.getState().player.personalPause).toBe(true);
    await expect(h!.engine.next()).resolves.toBeUndefined();
    await h!.engine.seek(1000);
    expect(useUI.getState().toasts.map((x) => x.text)).toContain(t('offlineControls'));

    // Play leaves the personal pause without bothering the user.
    useUI.setState({ toasts: [] });
    await h!.engine.play();
    expect(useRoom.getState().player.personalPause).toBe(false);
    expect(useUI.getState().toasts).toEqual([]);
    expect(h!.sockets.flatMap((s) => s.ofType('cmd'))).toEqual([]);
  });

  it('lets headset buttons pause only this phone unless configured otherwise', async () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      mediaSession: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: (a: string, fn: MediaSessionActionHandler | null) => handlers.set(a, fn),
        setPositionState: () => {},
      },
    });
    const { ws } = await online({ trackId: 'a', playing: true });
    const press = (a: string) => handlers.get(a)?.({ action: a as MediaSessionAction });

    press('pause');
    expect(useRoom.getState().player.personalPause).toBe(true);
    expect(ws.ofType('cmd')).toHaveLength(0);
    press('play');
    expect(useRoom.getState().player.personalPause).toBe(false);

    useSettings.getState().update({ headsetControls: 'room' });
    press('pause');
    expect(ws.lastCommand()?.op).toBe('pause');
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 12 });
    expect(ws.lastCommand()).toEqual({ op: 'seek', positionMs: 12_000 });
    press('nexttrack');
    expect(ws.lastCommand()).toEqual({ op: 'next' });
  });
});

describe('Engine lifecycle', () => {
  it('sends profile changes and reconnects after switching rooms', async () => {
    const { ws } = await online({ trackId: 'a' });
    useSettings.getState().update({ quality: 'low' });
    useSettings.getState().update({ name: 'Ala K.' });
    expect(ws.ofType('profile')).toEqual([
      { type: 'profile', quality: 'low' },
      { type: 'profile', name: 'Ala K.' },
    ]);

    useSettings.getState().update({ room: 'Bieganie' });
    expect(useRoom.getState().state.playback.trackId).toBe('');
    await vi.waitFor(() => expect(h!.sockets.length).toBe(2));
    const next = h!.sockets[1]!;
    next.open();
    expect(next.ofType('hello')[0]).toMatchObject({
      room: 'Bieganie',
      name: 'Ala K.',
      quality: 'low',
    });
  });

  it('halts when another tab takes over and can take the room back', async () => {
    const { ws } = await online();
    ws.receive({ type: 'error', code: 'replaced', message: 'opened elsewhere' });
    expect(useRoom.getState().halted).toBe('replaced');
    h!.engine.takeOver();
    expect(useRoom.getState().halted).toBeUndefined();
    expect(h!.sockets.length).toBe(2);
  });

  it('asks for an update when the protocol changed', async () => {
    const { ws } = await online();
    ws.receive({ type: 'error', code: 'protocol_mismatch', message: 'old client' });
    expect(useUI.getState().updateAvailable).toBe(true);
  });

  it('exposes diagnostics', async () => {
    const { h } = await online({ trackId: 'a', playing: true, anchorMs: Date.now() - 2000 });
    const info = h.engine.debugInfo();
    expect(info).toMatchObject({ trackId: 'a', playing: true, status: 'online' });
    expect(info.targetMs).toBeGreaterThanOrEqual(2000);
  });
});

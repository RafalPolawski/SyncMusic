import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomConnection, COMMAND_TTL, type SocketLike } from './connection';
import type { StateMessage } from './protocol';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
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
}

const welcome = {
  type: 'welcome',
  protocol: 1,
  serverTime: 0,
  room: { id: 'gym', name: 'Gym' },
  clientId: 'client-1',
  libraryVersion: 'v1',
  timing: { startDelayMs: 1500, resumeDelayMs: 400 },
  serverVersion: 'test',
};

function state(version: number, extra: Partial<StateMessage> = {}): StateMessage {
  return {
    type: 'state',
    version,
    serverTime: 0,
    playback: { trackId: 'a', positionMs: 0, anchorMs: 0, playing: true, durationMs: 1000 },
    contextIndex: 0,
    shuffle: false,
    repeat: 'off',
    waitForAll: true,
    queueVersion: 0,
    contextVersion: 0,
    ...extra,
  };
}

let clock = 0;
const win = new EventTarget() as unknown as Window;
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document;

function make() {
  const conn = new RoomConnection({
    url: 'ws://test/api/ws',
    hello: () => ({ clientId: 'client-1', name: 'Ala', room: 'gym', format: 'opus', quality: 'medium' }),
    socket: (u) => new FakeSocket(u),
    now: () => clock,
    random: () => 0.5,
    win,
    doc,
  });
  return conn;
}

function connect(_conn: RoomConnection): FakeSocket {
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.receive(welcome);
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  clock = 1_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

describe('RoomConnection', () => {
  it('sends hello and a ping burst on open', () => {
    const conn = make();
    const statuses: string[] = [];
    conn.subscribe({ status: (s) => statuses.push(s) });
    conn.start();
    const ws = FakeSocket.all[0]!;
    expect(statuses).toEqual(['connecting']);
    ws.open();
    expect(ws.sent[0]).toMatchObject({
      type: 'hello',
      protocol: 1,
      clientId: 'client-1',
      room: 'gym',
      name: 'Ala',
    });
    ws.receive(welcome);
    expect(statuses).toEqual(['connecting', 'online']);
    advance(1000);
    expect(ws.ofType('ping').length).toBe(6);
    advance(3000);
    expect(ws.ofType('ping').length).toBe(7);
    conn.stop();
  });

  it('feeds pongs into the clock', () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    const ping = ws.ofType('ping')[0]!;
    clock += 40;
    ws.receive({
      type: 'pong',
      id: ping.id,
      t0: ping.t0,
      t1: (ping.t0 as number) + 5020,
      t2: (ping.t0 as number) + 5021,
    });
    expect(conn.clock.rtt).toBe(39);
    expect(conn.clock.offset).toBeCloseTo(5000.5, 3);
    expect(conn.serverNow()).toBeCloseTo(clock + 5000.5, 3);
    // Unknown pong ids are ignored.
    ws.receive({ type: 'pong', id: 9999, t0: 0, t1: 0, t2: 0 });
    expect(conn.clock.sampleCount).toBe(1);
    conn.stop();
  });

  it('merges states and ignores stale versions', () => {
    const conn = make();
    const seen: { v: number; fresh: boolean }[] = [];
    conn.subscribe({ state: (s, fresh) => seen.push({ v: s.version, fresh }) });
    conn.start();
    const ws = connect(conn);
    ws.receive(
      state(5, {
        queue: [{ id: 'q1', trackId: 'b' }],
        context: { kind: 'folder', id: 'F', name: 'F', tracks: ['a'], order: [0] },
      }),
    );
    ws.receive(state(4));
    ws.receive(state(6));
    expect(seen).toEqual([
      { v: 5, fresh: true },
      { v: 6, fresh: false },
    ]);
    expect(conn.state.queue).toEqual([{ id: 'q1', trackId: 'b' }]);
    expect(conn.state.context.tracks).toEqual(['a']);
    // After a reconnect (e.g. server restart) a lower version is accepted.
    ws.drop();
    advance(1000);
    const ws2 = connect(conn);
    ws2.receive(state(1));
    expect(seen.at(-1)).toEqual({ v: 1, fresh: true });
    conn.stop();
  });

  it('reconnects with backoff after drops', () => {
    const conn = make();
    const statuses: string[] = [];
    conn.subscribe({ status: (s) => statuses.push(s) });
    conn.start();
    connect(conn).drop();
    expect(statuses.at(-1)).toBe('offline');
    expect(FakeSocket.all.length).toBe(1);
    advance(300);
    expect(FakeSocket.all.length).toBe(2);
    FakeSocket.all[1]!.drop();
    advance(300);
    expect(FakeSocket.all.length).toBe(2); // backoff doubled
    advance(300);
    expect(FakeSocket.all.length).toBe(3);
    connect(conn);
    expect(statuses.at(-1)).toBe('online');
    conn.stop();
    expect(statuses.at(-1)).toBe('idle');
  });

  it('reconnects immediately when the browser comes back online', () => {
    const conn = make();
    conn.start();
    connect(conn).drop();
    for (let i = 0; i < 5; i++) {
      advance(20_000);
      FakeSocket.all.at(-1)!.drop();
    }
    const before = FakeSocket.all.length;
    win.dispatchEvent(new Event('online'));
    expect(FakeSocket.all.length).toBe(before + 1);
    conn.stop();
  });

  it('detects silent dead connections', () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    ws.send = () => {}; // packets vanish
    advance(13_000);
    expect(ws.closed).toBe(true);
    advance(500);
    expect(FakeSocket.all.length).toBe(2);
    conn.stop();
  });

  it('acknowledges commands', async () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    const p = conn.send({ op: 'pause' });
    const sent = ws.ofType('cmd')[0]!;
    expect(sent.cmd).toEqual({ op: 'pause' });
    ws.receive({ type: 'ack', id: sent.id, ok: true, version: 3 });
    await expect(p).resolves.toMatchObject({ ok: true, version: 3 });
    expect(conn.pendingCount).toBe(0);
    conn.stop();
  });

  it('replays recent commands after reconnecting and expires old ones', async () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    ws.drop();
    const recent = conn.send({ op: 'next' });
    advance(500);
    const ws2 = connect(conn);
    const replayed = ws2.ofType('cmd');
    expect(replayed.map((m) => m.cmd)).toEqual([{ op: 'next' }]);
    ws2.receive({ type: 'ack', id: replayed[0]!.id, ok: true, version: 1 });
    await expect(recent).resolves.toMatchObject({ ok: true });

    ws2.drop();
    const old = conn.send({ op: 'pause' });
    advance(COMMAND_TTL + 1100);
    await expect(old).resolves.toMatchObject({ ok: false, error: { code: 'expired' } });
    conn.stop();
  });

  it('resends unacknowledged commands while online', () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    void conn.send({ op: 'next' });
    advance(4500);
    expect(ws.ofType('cmd').length).toBe(2);
    expect(ws.ofType('cmd')[0]!.id).toBe(ws.ofType('cmd')[1]!.id);
    conn.stop();
  });

  it('stops reconnecting when replaced by another tab', () => {
    const conn = make();
    const errors: string[] = [];
    conn.subscribe({ error: (e) => errors.push(e.code) });
    conn.start();
    const ws = connect(conn);
    ws.receive({ type: 'error', code: 'replaced', message: '' });
    ws.drop();
    advance(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(errors).toEqual(['replaced']);
    expect(conn.halted).toBe('replaced');
    conn.restart();
    expect(FakeSocket.all.length).toBe(2);
    conn.stop();
  });

  it('forwards presence and library notifications, ignores garbage', () => {
    const conn = make();
    const got: string[] = [];
    conn.subscribe({ presence: () => got.push('presence'), library: (v) => got.push('lib:' + v) });
    conn.start();
    const ws = connect(conn);
    ws.receive({ type: 'presence', members: [] });
    ws.receive({ type: 'library', version: 'v2' });
    ws.onmessage?.({ data: '{broken' } as MessageEvent);
    expect(got).toEqual(['presence', 'lib:v2']);
    conn.sendStatus({ trackId: 'a', ready: true, buffering: false, playing: true });
    conn.sendProfile({ name: 'Bob' });
    expect(ws.ofType('status').length).toBe(1);
    expect(ws.ofType('profile').length).toBe(1);
    conn.stop();
  });

  it('pings again when the app returns to the foreground', () => {
    const conn = make();
    conn.start();
    const ws = connect(conn);
    advance(1000);
    const before = ws.ofType('ping').length;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(ws.ofType('ping').length).toBe(before + 1);
    conn.stop();
  });
});

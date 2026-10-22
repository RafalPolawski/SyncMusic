// Room connection: a WebSocket that never gives up.
//
// - reconnects with exponential backoff and jitter, immediately when the
//   browser reports it is back online or the app returns to the foreground;
// - detects dead links with a watchdog (mobile networks often drop
//   connections silently);
// - keeps the clock calibrated with ping bursts after every (re)connect;
// - acknowledges commands, retries them across reconnects and drops
//   commands that became too old to make sense.

import { ClockSync, WallClockWatch } from './clock';
import {
  PROTOCOL_VERSION,
  emptyRoomState,
  mergeState,
  type Ack,
  type Command,
  type Presence,
  type RoomState,
  type ServerError,
  type ServerMessage,
  type Status,
  type Welcome,
} from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

export interface HelloInfo {
  clientId: string;
  name: string;
  room: string;
  format: string;
  quality: string;
}

export interface ConnectionListener {
  status?(status: ConnectionStatus): void;
  welcome?(w: Welcome): void;
  /** fresh is true for the first state after (re)connecting. */
  state?(s: RoomState, fresh: boolean): void;
  presence?(p: Presence): void;
  library?(version: string): void;
  error?(e: ServerError): void;
  clock?(): void;
}

export interface ConnectionOptions {
  url: string;
  hello: () => HelloInfo;
  clock?: ClockSync;
  socket?: (url: string) => SocketLike;
  now?: () => number;
  random?: () => number;
  /** Window used for online/visibility events (tests may pass a stub). */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
}

const OPEN = 1;
const PING_BURST = 6;
const PING_BURST_INTERVAL = 150;
const PING_INTERVAL = 3000;
const WATCHDOG_TIMEOUT = 12_000;
const RESEND_AFTER = 4000;
/** Commands older than this are not replayed after a reconnect. */
export const COMMAND_TTL = 8000;
const MAX_BACKOFF = 10_000;

interface Pending {
  id: string;
  cmd: Command;
  firstSentAt: number;
  lastSentAt: number;
  sent: boolean;
  resolve: (a: Ack) => void;
}

export class RoomConnection {
  readonly clock: ClockSync;
  status: ConnectionStatus = 'idle';
  state: RoomState = emptyRoomState();
  welcome: Welcome | undefined;

  private readonly opts: ConnectionOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly listeners = new Set<ConnectionListener>();
  private ws: SocketLike | undefined;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private pingSeq = 0;
  private pingsSent = 0;
  private pendingPings = new Map<number, number>();
  private lastMessageAt = 0;
  private freshState = false;
  private cmdSeq = 0;
  private pending = new Map<string, Pending>();
  private wallWatch: WallClockWatch;
  /** Set when the server tells us to stop (e.g. replaced by another tab). */
  halted: string | undefined;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? new ClockSync();
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.wallWatch = new WallClockWatch();
  }

  subscribe(l: ConnectionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit<K extends keyof ConnectionListener>(
    key: K,
    ...args: Parameters<NonNullable<ConnectionListener[K]>>
  ) {
    for (const l of this.listeners) {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    }
  }

  private win() {
    return this.opts.win === undefined ? (typeof window === 'undefined' ? null : window) : this.opts.win;
  }

  private doc() {
    return this.opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : this.opts.doc;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = undefined;
    this.win()?.addEventListener('online', this.onOnline);
    this.doc()?.addEventListener('visibilitychange', this.onVisible);
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.win()?.removeEventListener('online', this.onOnline);
    this.doc()?.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.tickTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pingTimer);
    this.closeSocket();
    for (const p of this.pending.values()) p.resolve(expiredAck(p.id, 'stopped'));
    this.pending.clear();
    this.setStatus('idle');
  }

  /** Reconnects now (e.g. after changing room or name). */
  restart(): void {
    this.stop();
    this.start();
  }

  private onOnline = () => this.reconnectNow();

  private onVisible = () => {
    if (this.doc()?.visibilityState !== 'visible') return;
    if (this.wallWatch.jumped()) this.clock.reset();
    if (this.ws?.readyState === OPEN) this.burstPings();
    else this.reconnectNow();
  };

  private reconnectNow(): void {
    if (this.stopped || this.halted) return;
    if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === 0)) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSocket();
    this.setStatus(this.attempt === 0 && this.status !== 'offline' ? 'connecting' : 'offline');
    let ws: SocketLike;
    try {
      ws = (this.opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.now();
      const h = this.opts.hello();
      this.write({ type: 'hello', protocol: PROTOCOL_VERSION, ...h });
      this.burstPings();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows.
    };
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        // already closed
      }
    }
    clearTimeout(this.pingTimer);
    this.pendingPings.clear();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.pingTimer);
    if (this.stopped || this.halted) return;
    this.setStatus('offline');
    const base = Math.min(MAX_BACKOFF, 300 * 2 ** this.attempt);
    const delay = base * (0.6 + this.random() * 0.4);
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private write(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  private burstPings(): void {
    clearTimeout(this.pingTimer);
    this.pingsSent = 0;
    this.sendPing();
  }

  private sendPing(): void {
    const id = ++this.pingSeq;
    const t0 = this.now();
    if (this.write({ type: 'ping', id, t0 })) {
      this.pendingPings.set(id, t0);
      if (this.pendingPings.size > 32) this.pendingPings.delete(this.pendingPings.keys().next().value!);
    }
    this.pingsSent++;
    const next = this.pingsSent < PING_BURST ? PING_BURST_INTERVAL : PING_INTERVAL;
    this.pingTimer = setTimeout(() => this.sendPing(), next);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'pong': {
        const t3 = this.now();
        if (!this.pendingPings.delete(msg.id)) return;
        this.clock.add({ t0: msg.t0, t1: msg.t1, t2: msg.t2, t3 });
        this.emit('clock');
        return;
      }
      case 'welcome':
        this.welcome = msg;
        this.attempt = 0;
        this.freshState = true;
        this.setStatus('online');
        this.emit('welcome', msg);
        this.replayPending();
        return;
      case 'state': {
        if (!this.freshState && msg.version <= this.state.version) return;
        const fresh = this.freshState;
        this.freshState = false;
        this.state = mergeState(this.state, msg);
        this.emit('state', this.state, fresh);
        return;
      }
      case 'presence':
        this.emit('presence', msg);
        return;
      case 'ack': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      case 'library':
        this.emit('library', msg.version);
        return;
      case 'error':
        if (msg.code === 'replaced' || msg.code === 'protocol_mismatch') {
          this.halted = msg.code;
          clearTimeout(this.reconnectTimer);
        }
        this.emit('error', msg);
        return;
    }
  }

  /** Sends a room command; resolves with the server's acknowledgement. */
  send(cmd: Command): Promise<Ack> {
    const id = 'c' + (++this.cmdSeq).toString(36) + '-' + Math.floor(this.random() * 1e9).toString(36);
    const now = this.now();
    return new Promise<Ack>((resolve) => {
      const p: Pending = { id, cmd, firstSentAt: now, lastSentAt: now, sent: false, resolve };
      this.pending.set(id, p);
      if (this.status === 'online') p.sent = this.write({ type: 'cmd', id, cmd });
    });
  }

  /** Reports playback status; dropped when offline (it would be stale). */
  sendStatus(s: Omit<Status, 'type'>): void {
    if (this.status === 'online') this.write({ type: 'status', ...s });
  }

  sendProfile(p: { name?: string; format?: string; quality?: string }): void {
    if (this.status === 'online') this.write({ type: 'profile', ...p });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private replayPending(): void {
    const now = this.now();
    for (const p of this.pending.values()) {
      if (now - p.firstSentAt > COMMAND_TTL) {
        this.pending.delete(p.id);
        p.resolve(expiredAck(p.id, 'expired'));
        continue;
      }
      p.lastSentAt = now;
      p.sent = this.write({ type: 'cmd', id: p.id, cmd: p.cmd });
    }
  }

  private tick(): void {
    const now = this.now();
    if (this.ws?.readyState === OPEN && now - this.lastMessageAt > WATCHDOG_TIMEOUT) {
      // Silent dead link: force a reconnect.
      this.closeSocket();
      this.scheduleReconnect();
      return;
    }
    for (const p of this.pending.values()) {
      if (now - p.firstSentAt > COMMAND_TTL) {
        this.pending.delete(p.id);
        p.resolve(expiredAck(p.id, 'expired'));
      } else if (this.status === 'online' && now - p.lastSentAt > RESEND_AFTER) {
        p.lastSentAt = now;
        p.sent = this.write({ type: 'cmd', id: p.id, cmd: p.cmd });
      }
    }
  }

  /** Current server time estimate (ms). */
  serverNow(): number {
    return this.clock.toServer(this.now());
  }
}

function expiredAck(id: string, code: string): Ack {
  return {
    type: 'ack',
    id,
    ok: false,
    version: 0,
    error: { code, message: 'command was not delivered in time' },
  };
}

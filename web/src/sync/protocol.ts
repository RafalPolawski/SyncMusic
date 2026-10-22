// Wire types of the room WebSocket. Mirrors internal/protocol and
// internal/room in the Go server; see docs/protocol.md.

export const PROTOCOL_VERSION = 1;

export type Repeat = 'off' | 'all' | 'one';

export interface Playback {
  trackId: string;
  entryId?: string;
  positionMs: number;
  anchorMs: number;
  playing: boolean;
  durationMs: number;
}

export interface QueueEntry {
  id: string;
  trackId: string;
  addedBy?: string;
}

export interface PlayContext {
  kind: string;
  id: string;
  name: string;
  tracks: string[];
  order: number[];
}

export interface Hold {
  trackId: string;
  entryId?: string;
  startedMs: number;
  untilMs: number;
}

/** Complete room state as tracked by the client. */
export interface RoomState {
  version: number;
  playback: Playback;
  contextIndex: number;
  shuffle: boolean;
  repeat: Repeat;
  waitForAll: boolean;
  hold?: Hold | null;
  queueVersion: number;
  queue: QueueEntry[];
  contextVersion: number;
  context: PlayContext;
}

export interface ContextSpec {
  kind: string;
  id: string;
  name: string;
  tracks: string[];
}

export type Command =
  | { op: 'play'; positionMs?: number }
  | { op: 'pause'; positionMs?: number }
  | { op: 'seek'; positionMs: number }
  | { op: 'next' }
  | { op: 'prev' }
  | { op: 'playContext'; context: ContextSpec; startIndex?: number }
  | { op: 'jump'; index: number }
  | { op: 'playEntry'; entryId: string }
  | { op: 'queueAdd'; trackIds: string[]; next?: boolean }
  | { op: 'queueRemove'; entryId: string }
  | { op: 'queueMove'; entryId: string; toIndex: number }
  | { op: 'queueClear' }
  | { op: 'shuffle'; on: boolean }
  | { op: 'repeat'; mode: Repeat }
  | { op: 'waitForAll'; on: boolean }
  | { op: 'ended'; trackId: string; entryId?: string };

export interface CommandError {
  code: string;
  message: string;
}

export interface Ack {
  type: 'ack';
  id: string;
  ok: boolean;
  version: number;
  error?: CommandError;
}

export interface Welcome {
  type: 'welcome';
  protocol: number;
  serverTime: number;
  room: { id: string; name: string };
  clientId: string;
  libraryVersion: string;
  timing: { startDelayMs: number; resumeDelayMs: number };
  serverVersion: string;
}

export interface Pong {
  type: 'pong';
  id: number;
  t0: number;
  t1: number;
  t2: number;
}

/** A state message; queue and context are only present when they changed. */
export interface StateMessage extends Omit<RoomState, 'queue' | 'context'> {
  type: 'state';
  serverTime: number;
  queue?: QueueEntry[];
  context?: PlayContext;
}

export interface Member {
  clientId: string;
  name: string;
  connected: boolean;
  trackId?: string;
  ready: boolean;
  buffering: boolean;
  playing: boolean;
  driftMs?: number;
  rttMs?: number;
  offline?: number;
  lastSeen: number;
}

export interface Presence {
  type: 'presence';
  members: Member[];
  waiting?: string[];
}

export interface LibraryChanged {
  type: 'library';
  version: string;
}

export interface ServerError {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage = Welcome | Pong | Ack | StateMessage | Presence | LibraryChanged | ServerError;

export interface Status {
  type: 'status';
  trackId: string;
  entryId?: string;
  ready: boolean;
  buffering: boolean;
  playing: boolean;
  driftMs?: number;
  rttMs?: number;
  offline?: number;
}

export function emptyRoomState(): RoomState {
  return {
    version: 0,
    playback: { trackId: '', positionMs: 0, anchorMs: 0, playing: false, durationMs: 0 },
    contextIndex: -1,
    shuffle: false,
    repeat: 'off',
    waitForAll: true,
    hold: null,
    queueVersion: 0,
    queue: [],
    contextVersion: 0,
    context: { kind: '', id: '', name: '', tracks: [], order: [] },
  };
}

/** Merges a state message into the previously known full state. */
export function mergeState(prev: RoomState, msg: StateMessage): RoomState {
  return {
    version: msg.version,
    playback: msg.playback,
    contextIndex: msg.contextIndex,
    shuffle: msg.shuffle,
    repeat: msg.repeat,
    waitForAll: msg.waitForAll,
    hold: msg.hold ?? null,
    queueVersion: msg.queueVersion,
    queue: msg.queue ?? prev.queue,
    contextVersion: msg.contextVersion,
    context: msg.context ?? prev.context,
  };
}

import { create } from 'zustand';
import type { ConnectionStatus } from '../sync/connection';
import { emptyRoomState, type Member, type RoomState, type Welcome } from '../sync/protocol';

export interface PlayerInfo {
  /** Track the local player has loaded. */
  trackId: string;
  ready: boolean;
  buffering: boolean;
  /** Audio is actually audible right now. */
  audible: boolean;
  driftMs: number | undefined;
  personalPause: boolean;
  needsGesture: boolean;
  unavailable: boolean;
}

interface RoomStore {
  status: ConnectionStatus;
  /** Effective room state (server state with optimistic local changes). */
  state: RoomState;
  welcome: Welcome | undefined;
  members: Member[];
  waiting: string[];
  rttMs: number | undefined;
  clockAccuracyMs: number | undefined;
  halted: string | undefined;
  player: PlayerInfo;
}

export const initialPlayer: PlayerInfo = {
  trackId: '',
  ready: false,
  buffering: false,
  audible: false,
  driftMs: undefined,
  personalPause: false,
  needsGesture: false,
  unavailable: false,
};

export const useRoom = create<RoomStore>(() => ({
  status: 'idle',
  state: emptyRoomState(),
  welcome: undefined,
  members: [],
  waiting: [],
  rttMs: undefined,
  clockAccuracyMs: undefined,
  halted: undefined,
  player: initialPlayer,
}));

export interface Toast {
  id: number;
  text: string;
}

interface UIStore {
  toasts: Toast[];
  /** Bumped when download state changes so views re-render. */
  downloadsVersion: number;
  updateAvailable: boolean;
  toast(text: string): void;
  dismiss(id: number): void;
}

let toastSeq = 0;

export const useUI = create<UIStore>((set, get) => ({
  toasts: [],
  downloadsVersion: 0,
  updateAvailable: false,
  toast(text) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.filter((t) => t.text !== text), { id, text }].slice(-3) });
    setTimeout(() => get().dismiss(id), 3500);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

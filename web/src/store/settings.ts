import { create } from 'zustand';
import type { Quality } from '../api';

export interface Settings {
  name: string;
  room: string;
  quality: Quality;
  /** Upcoming tracks downloaded in advance. */
  prefetch: number;
  /** Size limit of automatically downloaded tracks (MB). */
  autoCacheMB: number;
  /** Extra lead for delayed outputs such as Bluetooth headphones (ms). */
  latencyMs: number;
  /** Whether hardware/lock-screen buttons control only this phone or the room. */
  headsetControls: 'me' | 'room';
  language: 'auto' | 'pl' | 'en';
  volume: number;
}

const KEY = 'syncmusic.settings';
const CLIENT_KEY = 'syncmusic.clientId';

export const defaultSettings: Settings = {
  name: '',
  room: 'main',
  quality: 'medium',
  prefetch: 3,
  autoCacheMB: 500,
  latencyMs: 0,
  headsetControls: 'me',
  language: 'auto',
  volume: 1,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // corrupt or unavailable storage
  }
  return { ...defaultSettings };
}

interface SettingsStore extends Settings {
  update(patch: Partial<Settings>): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  update(patch) {
    set(patch);
    const { update: _update, ...rest } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      // ignore quota errors
    }
  },
}));

/** Stable per-device identifier used for presence and command de-duplication. */
export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = (
        crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
      ).replaceAll(/[^a-zA-Z0-9-]/g, '');
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return 'tmp-' + Math.random().toString(36).slice(2, 12);
  }
}

// Persistent client storage (IndexedDB): the cached library, metadata of
// downloaded tracks, the audio itself and small key/value records such as
// the last known room state.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface DownloadRecord {
  trackId: string;
  rev: string;
  format: string;
  quality: string;
  bytes: number;
  mime: string;
  /** Keys of the collections (folders/playlists) that pinned this track. */
  pinnedBy: string[];
  completedAt: number;
  lastUsed: number;
}

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  downloads: { key: string; value: DownloadRecord };
  audio: { key: string; value: Blob };
}

export interface AudioStore {
  put(trackId: string, blob: Blob): Promise<void>;
  get(trackId: string): Promise<Blob | undefined>;
  delete(trackId: string): Promise<void>;
}

export interface OfflineDB {
  getKV<T>(key: string): Promise<T | undefined>;
  setKV(key: string, value: unknown): Promise<void>;
  listDownloads(): Promise<DownloadRecord[]>;
  putDownload(r: DownloadRecord): Promise<void>;
  deleteDownload(trackId: string): Promise<void>;
  audio: AudioStore;
}

const DB_NAME = 'syncmusic';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<Schema>> | undefined;

function db(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore('kv');
      d.createObjectStore('downloads', { keyPath: 'trackId' });
      d.createObjectStore('audio');
    },
  });
  return dbPromise;
}

class IdbAudioStore implements AudioStore {
  async put(trackId: string, blob: Blob) {
    await (await db()).put('audio', blob, trackId);
  }
  async get(trackId: string) {
    return (await db()).get('audio', trackId);
  }
  async delete(trackId: string) {
    await (await db()).delete('audio', trackId);
  }
}

/** In-memory audio store used by tests (jsdom Blobs cannot be cloned into IndexedDB). */
export class MemoryAudioStore implements AudioStore {
  readonly blobs = new Map<string, Blob>();
  async put(trackId: string, blob: Blob) {
    this.blobs.set(trackId, blob);
  }
  async get(trackId: string) {
    return this.blobs.get(trackId);
  }
  async delete(trackId: string) {
    this.blobs.delete(trackId);
  }
}

export function createOfflineDB(audio: AudioStore = new IdbAudioStore()): OfflineDB {
  return {
    async getKV<T>(key: string) {
      return (await (await db()).get('kv', key)) as T | undefined;
    },
    async setKV(key, value) {
      await (await db()).put('kv', value, key);
    },
    async listDownloads() {
      return (await db()).getAll('downloads');
    },
    async putDownload(r) {
      await (await db()).put('downloads', r);
    },
    async deleteDownload(trackId) {
      const d = await db();
      await d.delete('downloads', trackId);
      await audio.delete(trackId);
    },
    audio,
  };
}

/** Test helper: closes and forgets the shared connection. */
export async function resetOfflineDBForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = undefined;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Asks the browser not to evict our storage under pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return undefined;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return undefined;
  }
}

import { create } from 'zustand';
import { api, type LibraryData, type LibraryFolder, type LibraryPlaylist, type LibraryTrack } from '../api';
import type { OfflineDB } from '../offline/db';

const CACHE_KEY = 'library';

interface Cached {
  etag: string;
  data: LibraryData;
}

export interface LibraryIndex {
  data: LibraryData;
  tracks: Map<string, LibraryTrack>;
  folders: Map<string, LibraryFolder>;
  playlists: Map<string, LibraryPlaylist>;
  /** Direct subfolders of each folder path. */
  children: Map<string, LibraryFolder[]>;
  /** All track ids below a folder, including subfolders, in library order. */
  deepTracks(path: string): string[];
}

export function buildIndex(data: LibraryData): LibraryIndex {
  const tracks = new Map(data.tracks.map((t) => [t.id, t]));
  const folders = new Map(data.folders.map((f) => [f.path, f]));
  const playlists = new Map(data.playlists.map((p) => [p.id, p]));
  const children = new Map<string, LibraryFolder[]>();
  for (const f of data.folders) {
    if (f.path === '') continue;
    const list = children.get(f.parent) ?? [];
    list.push(f);
    children.set(f.parent, list);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  const deepCache = new Map<string, string[]>();
  const deepTracks = (path: string): string[] => {
    const hit = deepCache.get(path);
    if (hit) return hit;
    const prefix = path === '' ? '' : path + '/';
    const ids = data.tracks.filter((t) => t.folder === path || t.folder.startsWith(prefix)).map((t) => t.id);
    deepCache.set(path, ids);
    return ids;
  };
  return { data, tracks, folders, playlists, children, deepTracks };
}

interface LibraryStore {
  index: LibraryIndex | undefined;
  etag: string;
  loading: boolean;
  error: string | undefined;
  load(db: OfflineDB): Promise<void>;
  refresh(db: OfflineDB): Promise<boolean>;
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  index: undefined,
  etag: '',
  loading: false,
  error: undefined,

  /** Shows the cached library instantly, then revalidates with the server. */
  async load(db) {
    if (!get().index) {
      const cached = await db.getKV<Cached>(CACHE_KEY).catch(() => undefined);
      if (cached?.data) set({ index: buildIndex(cached.data), etag: cached.etag });
    }
    await get().refresh(db);
  },

  /** Returns true when the library changed. */
  async refresh(db) {
    set({ loading: true });
    try {
      const res = await api.library(get().etag || undefined);
      if (!res) {
        set({ loading: false, error: undefined });
        return false;
      }
      set({ index: buildIndex(res.data), etag: res.etag, loading: false, error: undefined });
      await db.setKV(CACHE_KEY, { etag: res.etag, data: res.data } satisfies Cached).catch(() => undefined);
      return true;
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
}));

/** Case and accent insensitive search over the library. */
export function searchTracks(index: LibraryIndex, query: string, limit = 200): LibraryTrack[] {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const out: LibraryTrack[] = [];
  for (const t of index.data.tracks) {
    const hay = normalizeText([t.title, t.artist, t.album, t.folder, t.file].filter(Boolean).join(' '));
    if (terms.every((term) => hay.includes(term))) {
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replaceAll('ł', 'l');
}

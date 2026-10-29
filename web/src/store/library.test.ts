import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineDB, MemoryAudioStore, resetOfflineDBForTests, type OfflineDB } from '../offline/db';
import { mockFetch, sampleLibrary } from '../test/harness';
import { buildIndex, normalizeText, searchTracks, useLibrary } from './library';

describe('buildIndex', () => {
  const index = buildIndex(sampleLibrary);

  it('maps tracks, folders and playlists by id', () => {
    expect(index.tracks.get('d')?.title).toBe('Noc');
    expect(index.folders.get('Chill/Wieczór')?.parent).toBe('Chill');
    expect(index.playlists.get('p1')?.trackIds).toEqual(['c', 'e']);
  });

  it('lists subfolders sorted by name, without the root', () => {
    expect(index.children.get('')?.map((f) => f.name)).toEqual(['Chill', 'Siłownia']);
    expect(index.children.get('Chill')?.map((f) => f.path)).toEqual(['Chill/Wieczór']);
    expect(index.children.get('Siłownia')).toBeUndefined();
  });

  it('collects tracks of a folder including its subfolders', () => {
    expect(index.deepTracks('Chill')).toEqual(['d']);
    expect(index.deepTracks('Siłownia')).toEqual(['a', 'b', 'c']);
    expect(index.deepTracks('')).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Same prefix is not the same folder.
    const tricky = buildIndex({
      ...sampleLibrary,
      tracks: [...sampleLibrary.tracks, { ...sampleLibrary.tracks[0]!, id: 'x', folder: 'Chillout' }],
    });
    expect(tricky.deepTracks('Chill')).toEqual(['d']);
  });

  it('caches deep track lists', () => {
    expect(index.deepTracks('Siłownia')).toBe(index.deepTracks('Siłownia'));
  });
});

describe('searchTracks', () => {
  const index = buildIndex(sampleLibrary);
  const ids = (q: string) => searchTracks(index, q).map((t) => t.id);

  it('ignores case and Polish diacritics', () => {
    expect(ids('luzny')).toEqual(['e']);
    expect(ids('MARTWY CIAG')).toEqual(['c']);
    expect(ids('silownia')).toEqual(['a', 'b', 'c']);
  });

  it('requires every word to match somewhere', () => {
    expect(ids('bass lab ciąg')).toEqual(['c']);
    expect(ids('wieczor noc')).toEqual(['d']);
    expect(ids('noc rozgrzewka')).toEqual([]);
  });

  it('returns nothing for an empty query and respects the limit', () => {
    expect(ids('   ')).toEqual([]);
    expect(searchTracks(index, 'mp3', 2)).toHaveLength(2);
  });

  it('normalizes text', () => {
    expect(normalizeText('Łódź Żółć')).toBe('lodz zolc');
  });
});

describe('library store', () => {
  let db: OfflineDB;

  beforeEach(async () => {
    await resetOfflineDBForTests();
    db = createOfflineDB(new MemoryAudioStore());
    useLibrary.setState({ index: undefined, etag: '', loading: false, error: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads from the server and caches the result', async () => {
    const net = mockFetch({ '/api/library': { json: sampleLibrary, headers: { ETag: '"v1"' } } });
    await useLibrary.getState().load(db);
    expect(useLibrary.getState().index?.data.version).toBe('lib-1');
    expect(useLibrary.getState().etag).toBe('"v1"');
    expect(await db.getKV('library')).toMatchObject({ etag: '"v1"' });
    expect(net.calls).toEqual(['/api/library']);
  });

  it('shows the cached copy and revalidates with its etag', async () => {
    await db.setKV('library', { etag: '"v1"', data: sampleLibrary });
    let sentEtag: string | undefined;
    mockFetch({
      '/api/library': (init) => {
        sentEtag = (init?.headers as Record<string, string>)['If-None-Match'];
        return { status: 304 };
      },
    });
    await useLibrary.getState().load(db);
    expect(sentEtag).toBe('"v1"');
    expect(useLibrary.getState().index?.tracks.size).toBe(5);
    expect(useLibrary.getState().loading).toBe(false);
  });

  it('keeps the cached library when the server is unreachable', async () => {
    await db.setKV('library', { etag: '"v1"', data: sampleLibrary });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await useLibrary.getState().load(db);
    expect(useLibrary.getState().index?.tracks.size).toBe(5);
    expect(useLibrary.getState().error).toContain('Failed to fetch');
  });

  it('reports whether a refresh changed anything', async () => {
    mockFetch({ '/api/library': { json: sampleLibrary, headers: { ETag: '"v1"' } } });
    expect(await useLibrary.getState().refresh(db)).toBe(true);
    mockFetch({ '/api/library': { status: 304 } });
    expect(await useLibrary.getState().refresh(db)).toBe(false);
    mockFetch({ '/api/library': { status: 500, json: {} } });
    expect(await useLibrary.getState().refresh(db)).toBe(false);
    expect(useLibrary.getState().error).toBe('HTTP 500');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineDB, MemoryAudioStore, resetOfflineDBForTests, type OfflineDB } from './db';
import { Downloader, type TrackRef } from './downloader';

interface Route {
  status?: number;
  body?: Uint8Array<ArrayBuffer>;
  fail?: boolean;
  hang?: boolean;
}

function makeFetch(routes: Map<string, Route[]>, calls: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const queue = routes.get(url) ?? [];
    const route = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 404 });
    if (route.fail) throw new TypeError('network down');
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const body = route.body ?? new Uint8Array();
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'audio/ogg', 'Content-Length': String(body.byteLength) },
    });
  });
}

const bytes = (n: number) => new Uint8Array(n).fill(7);
const ref = (id: string, rev = 'r1'): TrackRef => ({ id, rev });

let db: OfflineDB;
let audio: MemoryAudioStore;
let now = 1000;

beforeEach(async () => {
  await resetOfflineDBForTests();
  audio = new MemoryAudioStore();
  db = createOfflineDB(audio);
  now = 1000;
});

afterEach(() => {
  vi.useRealTimers();
});

function make(
  routes: Map<string, Route[]>,
  calls: string[] = [],
  opts: { limit?: number; online?: () => boolean } = {},
) {
  return new Downloader({
    db,
    fetch: makeFetch(routes, calls) as unknown as typeof fetch,
    url: (t, p) => `/api/tracks/${t.id}/audio?f=${p.format}&q=${p.quality}&v=${t.rev}`,
    profile: () => ({ format: 'opus', quality: 'medium' }),
    autoLimitBytes: () => opts.limit ?? 1e9,
    concurrency: 1,
    now: () => now,
    isOnline: opts.online,
  });
}

const url = (id: string, rev = 'r1') => `/api/tracks/${id}/audio?f=opus&q=medium&v=${rev}`;

async function settle(d: Downloader, ids: string[]) {
  await vi.waitFor(() => {
    for (const id of ids) expect(d.isDownloaded(id) || d.error(id) !== undefined).toBe(true);
  });
}

describe('Downloader', () => {
  it('prefetches in priority order and stores audio', async () => {
    const routes = new Map([
      [url('a'), [{ body: bytes(10) }]],
      [url('b'), [{ body: bytes(20) }]],
    ]);
    const calls: string[] = [];
    const d = make(routes, calls);
    await d.whenReady();
    d.setPrefetch([ref('a'), ref('b')]);
    await settle(d, ['a', 'b']);
    expect(calls).toEqual([url('a'), url('b')]);
    expect(audio.blobs.get('a')?.size).toBe(10);
    expect(d.stats()).toMatchObject({ bytes: 30, tracks: 2, pinnedBytes: 0 });
    expect((await d.blob('b'))?.size).toBe(20);
    const records = await db.listDownloads();
    expect(records.map((r) => r.trackId).sort()).toEqual(['a', 'b']);
  });

  it('does not download twice and survives restarts', async () => {
    const routes = new Map([[url('a'), [{ body: bytes(5) }]]]);
    const calls: string[] = [];
    const d1 = make(routes, calls);
    await d1.whenReady();
    d1.setPrefetch([ref('a')]);
    await settle(d1, ['a']);
    d1.setPrefetch([ref('a')]);
    const d2 = make(routes, calls);
    await d2.whenReady();
    expect(d2.isDownloaded('a')).toBe(true);
    d2.setPrefetch([ref('a')]);
    expect(calls.length).toBe(1);
  });

  it('re-downloads when the file revision changed', async () => {
    const routes = new Map([
      [url('a'), [{ body: bytes(5) }]],
      [url('a', 'r2'), [{ body: bytes(6) }]],
    ]);
    const d = make(routes);
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    await settle(d, ['a']);
    d.setPrefetch([ref('a', 'r2')]);
    await vi.waitFor(() => expect(audio.blobs.get('a')?.size).toBe(6));
  });

  it('retries transient failures with backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = new Map([[url('a'), [{ fail: true }, { status: 503 }, { body: bytes(3) }]]]);
    const calls: string[] = [];
    const d = make(routes, calls);
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(d.activeCount).toBe(0));
    expect(d.isQueued('a')).toBe(true);
    now += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    await vi.waitFor(() => expect(d.activeCount).toBe(0));
    now += 4000;
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(d.isDownloaded('a')).toBe(true));
    expect(calls.length).toBe(3);
  });

  it('gives up on client errors', async () => {
    const routes = new Map([[url('a'), [{ status: 404 }]]]);
    const d = make(routes);
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    await settle(d, ['a']);
    expect(d.error('a')).toBe('http_404');
    expect(d.isQueued('a')).toBe(false);
  });

  it('aborts stalled downloads and retries them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const routes = new Map([[url('a'), [{ hang: true }, { body: bytes(2) }]]]);
    const calls: string[] = [];
    const d = new Downloader({
      db,
      fetch: makeFetch(routes, calls) as unknown as typeof fetch,
      url: (t, p) => `/api/tracks/${t.id}/audio?f=${p.format}&q=${p.quality}&v=${t.rev}`,
      profile: () => ({ format: 'opus', quality: 'medium' }),
      autoLimitBytes: () => 1e9,
      now: () => now,
      stallTimeoutMs: 1000,
    });
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    await vi.advanceTimersByTimeAsync(1000);
    now += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(d.isDownloaded('a')).toBe(true));
    expect(calls.length).toBe(2);
  });

  it('evicts least recently used prefetched tracks but keeps pinned and upcoming ones', async () => {
    const routes = new Map(
      ['a', 'b', 'c', 'p'].map((id) => [url(id), [{ body: bytes(100) }]] as [string, Route[]]),
    );
    const d = make(routes, [], { limit: 250 });
    await d.whenReady();
    await d.pin('folder:X', [ref('p')]);
    await settle(d, ['p']);
    now = 2000;
    d.setPrefetch([ref('a')]);
    await settle(d, ['a']);
    now = 3000;
    d.setPrefetch([ref('b')]);
    await settle(d, ['b']);
    now = 4000;
    d.setPrefetch([ref('c')]);
    await settle(d, ['c']);
    // a (oldest auto) evicted; pinned p kept although total is 300.
    await vi.waitFor(() => expect(d.isDownloaded('a')).toBe(false));
    expect(d.isDownloaded('b')).toBe(true);
    expect(d.isDownloaded('c')).toBe(true);
    expect(d.isDownloaded('p')).toBe(true);
    expect(d.stats().pinnedBytes).toBe(100);
  });

  it('pins and unpins collections', async () => {
    const routes = new Map(
      ['a', 'b', 'c'].map((id) => [url(id), [{ body: bytes(10) }]] as [string, Route[]]),
    );
    const d = make(routes);
    await d.whenReady();
    await d.pin('folder:A', [ref('a'), ref('b')]);
    await d.pin('folder:B', [ref('b'), ref('c')]);
    await settle(d, ['a', 'b', 'c']);
    expect(d.collectionStatus(['a', 'b'])).toEqual({ downloaded: 2, total: 2, active: false });
    expect(d.isPinned('folder:A')).toBe(true);
    await d.unpin('folder:A');
    expect(d.isDownloaded('a')).toBe(false);
    expect(d.isDownloaded('b')).toBe(true); // still pinned by B
    expect(d.pinnedKeys()).toEqual(['folder:B']);
    // Pins survive restarts and missing tracks are resumed.
    audio.blobs.delete('c');
    await db.deleteDownload('c');
    const d2 = make(routes);
    await d2.whenReady();
    expect(d2.isPinned('folder:B')).toBe(true);
    d2.resumePins((id) => ref(id));
    await settle(d2, ['c']);
    expect(d2.isDownloaded('c')).toBe(true);
    await d2.clear();
    expect(d2.stats().tracks).toBe(0);
    expect(d2.pinnedKeys()).toEqual([]);
  });

  it('drops metadata whose audio vanished', async () => {
    const routes = new Map([[url('a'), [{ body: bytes(4) }]]]);
    const d = make(routes);
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    await settle(d, ['a']);
    audio.blobs.clear();
    expect(await d.blob('a')).toBeUndefined();
    expect(d.isDownloaded('a')).toBe(false);
  });

  it('waits while offline', async () => {
    let online = false;
    const calls: string[] = [];
    const d = make(new Map([[url('a'), [{ body: bytes(1) }]]]), calls, { online: () => online });
    await d.whenReady();
    d.setPrefetch([ref('a')]);
    expect(calls.length).toBe(0);
    online = true;
    d.retry();
    await settle(d, ['a']);
    expect(calls.length).toBe(1);
  });

  it('drops prefetch jobs that are no longer upcoming', async () => {
    const calls: string[] = [];
    const routes = new Map([
      [url('a'), [{ hang: true }]],
      [url('b'), [{ body: bytes(1) }]],
      [url('c'), [{ body: bytes(1) }]],
    ]);
    const d = make(routes, calls);
    await d.whenReady();
    d.setPrefetch([ref('a'), ref('b')]);
    d.setPrefetch([ref('c')]);
    expect(d.isQueued('b')).toBe(false);
    d.dispose();
  });
});

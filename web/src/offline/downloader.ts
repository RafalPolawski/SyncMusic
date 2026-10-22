// Downloads tracks for offline playback.
//
// Two kinds of downloads share one priority queue:
//  - prefetch: the current and next few tracks of the room, refreshed on
//    every room change, kept in a size-bounded LRU so they never fill the
//    phone;
//  - pins: whole folders or playlists the listener saved for offline use,
//    kept until removed.
// Every download is retried with exponential backoff, so a gym with spotty
// Wi-Fi eventually gets everything without anybody pressing "retry".

import type { DownloadRecord, OfflineDB } from './db';

export interface TrackRef {
  id: string;
  rev: string;
}

export interface Profile {
  format: string;
  quality: string;
}

export interface Progress {
  loaded: number;
  total: number;
}

export interface DownloaderOptions {
  db: OfflineDB;
  fetch?: typeof fetch;
  /** Builds the audio URL for a track. */
  url: (t: TrackRef, p: Profile) => string;
  profile: () => Profile;
  /** Size limit for prefetched (not pinned) tracks, bytes. */
  autoLimitBytes: () => number;
  concurrency?: number;
  now?: () => number;
  isOnline?: () => boolean;
  onChange?: () => void;
  /** Abort a download when no data arrives for this long (ms). */
  stallTimeoutMs?: number;
}

const PIN_PRIORITY = 1000;
const MAX_ATTEMPTS = 8;
const PINS_KEY = 'pins';

interface Job {
  ref: TrackRef;
  priority: number;
  attempts: number;
  nextTryAt: number;
}

interface Active {
  job: Job;
  abort: AbortController;
  progress: Progress;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class Downloader {
  private readonly o: Required<Omit<DownloaderOptions, 'onChange'>> & Pick<DownloaderOptions, 'onChange'>;
  private records = new Map<string, DownloadRecord>();
  private jobs = new Map<string, Job>();
  private active = new Map<string, Active>();
  private failed = new Map<string, string>();
  private pins = new Map<string, string[]>();
  private refs = new Map<string, TrackRef>();
  private prefetch: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  quotaExceeded = false;
  private ready: Promise<void>;

  constructor(opts: DownloaderOptions) {
    this.o = {
      fetch: (...a) => fetch(...a),
      concurrency: 2,
      now: () => Date.now(),
      isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      stallTimeoutMs: 20_000,
      ...(Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as DownloaderOptions),
    };
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [records, pins] = await Promise.all([
      this.o.db.listDownloads(),
      this.o.db.getKV<Record<string, string[]>>(PINS_KEY),
    ]);
    for (const r of records) this.records.set(r.trackId, r);
    for (const [k, ids] of Object.entries(pins ?? {})) this.pins.set(k, ids);
    this.changed(true);
  }

  /** Resolves once persisted state has been loaded. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  // ---- queries -----------------------------------------------------------

  isDownloaded(id: string): boolean {
    return this.records.has(id);
  }

  progress(id: string): Progress | undefined {
    return this.active.get(id)?.progress;
  }

  /** Number of downloads currently transferring. */
  get activeCount(): number {
    return this.active.size;
  }

  isQueued(id: string): boolean {
    return this.jobs.has(id) || this.active.has(id);
  }

  error(id: string): string | undefined {
    return this.failed.get(id);
  }

  downloadedIds(): string[] {
    return [...this.records.keys()];
  }

  pinnedKeys(): string[] {
    return [...this.pins.keys()];
  }

  isPinned(key: string): boolean {
    return this.pins.has(key);
  }

  /** Summary of a collection's offline state. */
  collectionStatus(ids: string[]): { downloaded: number; total: number; active: boolean } {
    let downloaded = 0;
    let active = false;
    for (const id of ids) {
      if (this.records.has(id)) downloaded++;
      else if (this.isQueued(id)) active = true;
    }
    return { downloaded, total: ids.length, active };
  }

  stats(): { bytes: number; pinnedBytes: number; tracks: number; queued: number } {
    let bytes = 0;
    let pinnedBytes = 0;
    for (const r of this.records.values()) {
      bytes += r.bytes;
      if (this.isPinnedTrack(r.trackId)) pinnedBytes += r.bytes;
    }
    return { bytes, pinnedBytes, tracks: this.records.size, queued: this.jobs.size + this.active.size };
  }

  /** Returns the stored audio and refreshes its LRU position. */
  async blob(id: string): Promise<Blob | undefined> {
    const r = this.records.get(id);
    if (!r) return undefined;
    const b = await this.o.db.audio.get(id);
    if (!b) {
      // Metadata without data (e.g. storage cleared by the browser).
      this.records.delete(id);
      await this.o.db.deleteDownload(id);
      this.changed();
      return undefined;
    }
    r.lastUsed = this.o.now();
    void this.o.db.putDownload(r);
    return b;
  }

  // ---- commands ----------------------------------------------------------

  /**
   * Replaces the prefetch list (current track first). Tracks dropping out of
   * the list are no longer fetched unless pinned.
   */
  setPrefetch(refs: TrackRef[]): void {
    const ids = refs.map((r) => r.id);
    this.prefetch = ids;
    for (const [id, job] of this.jobs) {
      if (job.priority < PIN_PRIORITY && !ids.includes(id)) this.jobs.delete(id);
    }
    refs.forEach((ref, i) => this.enqueue(ref, i + 1));
    this.pump();
  }

  /** Saves a collection for offline use. */
  async pin(key: string, refs: TrackRef[]): Promise<void> {
    await this.ready;
    this.pins.set(
      key,
      refs.map((r) => r.id),
    );
    await this.savePins();
    refs.forEach((ref, i) => this.enqueue(ref, PIN_PRIORITY + i));
    this.changed();
    this.pump();
  }

  /** Removes a saved collection, deleting tracks nobody else needs. */
  async unpin(key: string): Promise<void> {
    await this.ready;
    const ids = this.pins.get(key) ?? [];
    this.pins.delete(key);
    await this.savePins();
    for (const id of ids) {
      if (this.isPinnedTrack(id)) continue;
      const job = this.jobs.get(id);
      if (job && job.priority >= PIN_PRIORITY) this.jobs.delete(id);
      const act = this.active.get(id);
      if (act && act.job.priority >= PIN_PRIORITY && !this.prefetch.includes(id)) act.abort.abort();
      if (this.records.has(id) && !this.prefetch.includes(id)) await this.remove(id);
    }
    this.changed();
  }

  /** Deletes every download. */
  async clear(): Promise<void> {
    await this.ready;
    for (const a of this.active.values()) a.abort.abort();
    this.jobs.clear();
    this.pins.clear();
    await this.savePins();
    for (const id of [...this.records.keys()]) await this.remove(id);
    this.failed.clear();
    this.quotaExceeded = false;
    this.changed();
  }

  /** Retries failed downloads now (e.g. when the network came back). */
  retry(): void {
    this.failed.clear();
    this.quotaExceeded = false;
    for (const job of this.jobs.values()) {
      job.nextTryAt = 0;
      job.attempts = 0;
    }
    this.resumePins((id) => this.refs.get(id));
  }

  /**
   * Queues pinned tracks that are missing or outdated, e.g. after a restart
   * or a library update. lookup resolves current track revisions.
   */
  resumePins(lookup: (id: string) => TrackRef | undefined): void {
    for (const ids of this.pins.values()) {
      ids.forEach((id, i) => {
        const ref = lookup(id);
        if (ref) this.enqueue(ref, PIN_PRIORITY + i);
      });
    }
    this.pump();
  }

  // ---- internals ---------------------------------------------------------

  private isPinnedTrack(id: string): boolean {
    for (const ids of this.pins.values()) if (ids.includes(id)) return true;
    return false;
  }

  private async savePins(): Promise<void> {
    await this.o.db.setKV(PINS_KEY, Object.fromEntries(this.pins));
  }

  private enqueue(ref: TrackRef, priority: number): void {
    this.refs.set(ref.id, ref);
    const rec = this.records.get(ref.id);
    if (rec && rec.rev === ref.rev) return;
    if (this.active.has(ref.id)) {
      const a = this.active.get(ref.id)!;
      a.job.priority = Math.min(a.job.priority, priority);
      return;
    }
    const existing = this.jobs.get(ref.id);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return;
    }
    if (this.failed.has(ref.id)) return;
    this.jobs.set(ref.id, { ref, priority, attempts: 0, nextTryAt: 0 });
  }

  private pump(): void {
    clearTimeout(this.timer);
    if (!this.o.isOnline()) return;
    const now = this.o.now();
    while (this.active.size < this.o.concurrency) {
      let best: Job | undefined;
      let wakeAt = Infinity;
      for (const j of this.jobs.values()) {
        if (this.quotaExceeded && j.priority >= PIN_PRIORITY) continue;
        if (j.nextTryAt > now) {
          wakeAt = Math.min(wakeAt, j.nextTryAt);
          continue;
        }
        if (!best || j.priority < best.priority) best = j;
      }
      if (!best) {
        if (wakeAt < Infinity) this.timer = setTimeout(() => this.pump(), wakeAt - now);
        break;
      }
      this.jobs.delete(best.ref.id);
      this.start(best);
    }
    this.changed();
  }

  private start(job: Job): void {
    const abort = new AbortController();
    const act: Active = { job, abort, progress: { loaded: 0, total: 0 } };
    this.active.set(job.ref.id, act);
    this.download(act)
      .then(() => {
        this.failed.delete(job.ref.id);
      })
      .catch((err: unknown) => this.onError(job, err, abort.signal.aborted))
      .finally(() => {
        this.active.delete(job.ref.id);
        this.changed();
        this.pump();
      });
  }

  private onError(job: Job, err: unknown, aborted: boolean): void {
    const wanted = this.prefetch.includes(job.ref.id) || this.isPinnedTrack(job.ref.id);
    if (aborted && !wanted) return; // cancelled on purpose
    if (isQuotaError(err)) {
      this.quotaExceeded = true;
      this.failed.set(job.ref.id, 'quota');
      return;
    }
    if (
      err instanceof HttpError &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 408 &&
      err.status !== 429
    ) {
      this.failed.set(job.ref.id, `http_${err.status}`);
      return;
    }
    job.attempts++;
    if (job.attempts >= MAX_ATTEMPTS) {
      this.failed.set(job.ref.id, 'network');
      return;
    }
    job.nextTryAt = this.o.now() + Math.min(60_000, 2000 * 2 ** (job.attempts - 1));
    if (wanted && !this.jobs.has(job.ref.id)) this.jobs.set(job.ref.id, job);
  }

  private async download(act: Active): Promise<void> {
    const { ref } = act.job;
    const profile = this.o.profile();
    const url = this.o.url(ref, profile);
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => act.abort.abort(), this.o.stallTimeoutMs);
    };
    armStall();
    try {
      const res = await this.o.fetch(url, { signal: act.abort.signal, credentials: 'same-origin' });
      if (!res.ok) throw new HttpError(res.status);
      const total = Number(res.headers.get('Content-Length') ?? 0);
      act.progress = { loaded: 0, total };
      const chunks: BlobPart[] = [];
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          chunks.push(value);
          act.progress = { loaded: act.progress.loaded + value.byteLength, total };
          this.changed();
        }
      } else {
        const buf = await res.arrayBuffer();
        chunks.push(buf);
        act.progress = { loaded: buf.byteLength, total };
      }
      const mime = res.headers.get('Content-Type') ?? 'application/octet-stream';
      const blob = new Blob(chunks, { type: mime });
      if (total > 0 && blob.size !== total) throw new Error('incomplete download');
      await this.o.db.audio.put(ref.id, blob);
      const now = this.o.now();
      const rec: DownloadRecord = {
        trackId: ref.id,
        rev: ref.rev,
        format: profile.format,
        quality: profile.quality,
        bytes: blob.size,
        mime,
        pinnedBy: [],
        completedAt: now,
        lastUsed: now,
      };
      await this.o.db.putDownload(rec);
      this.records.set(ref.id, rec);
      await this.evict();
    } finally {
      clearTimeout(stall);
    }
  }

  /** Keeps prefetched (unpinned) downloads within the size limit. */
  private async evict(): Promise<void> {
    const limit = this.o.autoLimitBytes();
    const auto = [...this.records.values()].filter((r) => !this.isPinnedTrack(r.trackId));
    let total = auto.reduce((s, r) => s + r.bytes, 0);
    if (total <= limit) return;
    const keep = new Set(this.prefetch);
    auto.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const r of auto) {
      if (total <= limit) break;
      if (keep.has(r.trackId)) continue;
      await this.remove(r.trackId);
      total -= r.bytes;
    }
  }

  private async remove(id: string): Promise<void> {
    this.records.delete(id);
    await this.o.db.deleteDownload(id);
  }

  /** Coalesces change notifications (progress updates are frequent). */
  private changed(immediate = false): void {
    if (!this.o.onChange) return;
    if (immediate) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
      this.o.onChange();
      return;
    }
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.o.onChange?.();
    }, 200);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.changeTimer);
    for (const a of this.active.values()) a.abort.abort();
  }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

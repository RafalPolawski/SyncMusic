// The engine ties everything together: the room connection, the shared
// timeline, the offline downloader and the audio player. UI components talk
// to it through the exported singleton and read its state from the stores.

import { audioUrl, coverUrl, preferredFormat, type LibraryTrack } from './api';
import { setMediaHandlers, setMediaMetadata, setMediaPlaybackState } from './audio/mediaSession';
import { AudioPlayer, type MediaLike, type Source } from './audio/player';
import { t } from './i18n';
import { createOfflineDB, type OfflineDB } from './offline/db';
import { Downloader, type TrackRef } from './offline/downloader';
import { useLibrary, type LibraryIndex } from './store/library';
import { useRoom, useUI } from './store/room';
import { clientId, useSettings } from './store/settings';
import { ClockSync } from './sync/clock';
import { RoomConnection, type SocketLike } from './sync/connection';
import {
  emptyRoomState,
  type Ack,
  type Command,
  type ContextSpec,
  type Repeat,
  type RoomState,
} from './sync/protocol';
import {
  normalize,
  positionAt,
  target as timelineTarget,
  upcoming,
  type Catalog,
  type Target,
} from './sync/timeline';

const OFFSET_KEY = 'syncmusic.clockOffset';
const BIAS_KEY = 'syncmusic.playBias';
const SNAPSHOT_KEY = 'room:';
/** Treat the connection as usable for this long after it dropped. */
const RECONNECT_GRACE_MS = 10_000;
const OPTIMISTIC_TTL_MS = 4000;
const STATUS_INTERVAL_MS = 3000;

interface Optimistic {
  state: RoomState;
  baseVersion: number;
  expires: number;
}

export interface EngineOptions {
  element?: MediaLike;
  db?: OfflineDB;
  socket?: (url: string) => SocketLike;
  wsUrl?: string;
}

export class Engine {
  readonly db: OfflineDB;
  readonly conn: RoomConnection;
  readonly downloader: Downloader;
  readonly player: AudioPlayer;
  private optimistic: Optimistic | undefined;
  private lastOnlineAt = 0;
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribers: (() => void)[] = [];
  private started = false;
  private format = preferredFormat();

  constructor(opts: EngineOptions = {}) {
    this.db = opts.db ?? createOfflineDB();
    const saved = Number(localStorage.getItem(OFFSET_KEY));
    const clock = new ClockSync({}, Number.isFinite(saved) && saved !== 0 ? saved : undefined);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.conn = new RoomConnection({
      url: opts.wsUrl ?? `${proto}//${location.host}/api/ws`,
      clock,
      socket: opts.socket,
      hello: () => {
        const s = useSettings.getState();
        return { clientId: clientId(), name: s.name, room: s.room, format: this.format, quality: s.quality };
      },
    });
    this.downloader = new Downloader({
      db: this.db,
      url: (ref, p) => audioUrl(ref, p),
      profile: () => ({ format: this.format, quality: useSettings.getState().quality }),
      autoLimitBytes: () => useSettings.getState().autoCacheMB * 1024 * 1024,
      onChange: () => useUI.setState((s) => ({ downloadsVersion: s.downloadsVersion + 1 })),
    });
    const bias = Number(localStorage.getItem(BIAS_KEY));
    this.player = new AudioPlayer({
      element: opts.element ?? (new Audio() as unknown as MediaLike),
      resolve: (id, o) => this.resolveSource(id, o.bypassCache),
      now: () => this.serverNow(),
      target: (now) => this.target(now),
      latencyMs: () => useSettings.getState().latencyMs,
      onChange: (s) => {
        useRoom.setState({ player: s });
        this.updateMediaSession();
        this.reportStatusSoon();
      },
      onExternalPause: () => this.updateMediaSession(),
      onEnded: (id) => this.onTrackEnded(id),
    });
    if (Number.isFinite(bias)) this.player.drift.seekBiasMs = bias;
    this.player.setVolume(useSettings.getState().volume);
  }

  // ---- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.restoreSnapshot();
    this.unsubscribers.push(
      this.conn.subscribe({
        status: (status) => {
          if (status === 'online') this.lastOnlineAt = Date.now();
          useRoom.setState({ status, halted: this.conn.halted });
          this.player.tick();
        },
        welcome: (w) => {
          useRoom.setState({ welcome: w });
          const index = useLibrary.getState().index;
          if (index && w.libraryVersion && index.data.version !== w.libraryVersion)
            void this.refreshLibrary(false);
        },
        state: (s) => this.onServerState(s),
        presence: (p) => useRoom.setState({ members: p.members, waiting: p.waiting ?? [] }),
        library: () => void this.refreshLibrary(true),
        clock: () => {
          const c = this.conn.clock;
          useRoom.setState({ rttMs: c.lastRtt, clockAccuracyMs: c.accuracy });
          if (c.offset !== undefined) localStorage.setItem(OFFSET_KEY, String(Math.round(c.offset)));
        },
        error: (e) => {
          if (e.code === 'replaced') useRoom.setState({ halted: 'replaced' });
          else if (e.code === 'protocol_mismatch') useUI.setState({ updateAvailable: true });
        },
      }),
      useSettings.subscribe((s, prev) => {
        if (s.volume !== prev.volume) this.player.setVolume(s.volume);
        if (s.quality !== prev.quality) this.conn.sendProfile({ quality: s.quality });
        if (s.name !== prev.name) this.conn.sendProfile({ name: s.name });
        if (s.prefetch !== prev.prefetch || s.quality !== prev.quality) this.updatePrefetch();
        if (s.room !== prev.room) this.switchRoom();
        if (s.latencyMs !== prev.latencyMs) this.player.tick();
      }),
      useLibrary.subscribe((l, prev) => {
        if (l.index !== prev.index) this.onLibrary();
      }),
    );
    setMediaHandlers({
      play: () => this.mediaPlay(),
      pause: () => this.mediaPause(),
      next: () => void this.next(),
      previous: () => void this.prev(),
      seekTo: (ms) => {
        if (useSettings.getState().headsetControls === 'room') void this.seek(ms);
      },
    });
    this.statusTimer = setInterval(() => this.reportStatus(), STATUS_INTERVAL_MS);
    window.addEventListener('online', this.onOnline);
    this.onLibrary();
    this.conn.start();
  }

  stop(): void {
    this.started = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    clearInterval(this.statusTimer);
    window.removeEventListener('online', this.onOnline);
    this.conn.stop();
  }

  private onOnline = () => this.downloader.retry();

  private switchRoom(): void {
    this.optimistic = undefined;
    this.conn.state = emptyRoomState();
    useRoom.setState({ state: this.conn.state, members: [], waiting: [] });
    void this.restoreSnapshot().then(() => this.conn.restart());
  }

  /** Continues from the last known room state while offline after a restart. */
  private async restoreSnapshot(): Promise<void> {
    const room = useSettings.getState().room;
    const snap = await this.db.getKV<RoomState>(SNAPSHOT_KEY + room.toLowerCase()).catch(() => undefined);
    if (snap && this.conn.state.version === 0) {
      this.conn.state = { ...emptyRoomState(), ...snap };
      this.publishState();
    }
  }

  private saveSnapshotSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const room = useSettings.getState().room;
      void this.db.setKV(SNAPSHOT_KEY + room.toLowerCase(), this.conn.state).catch(() => undefined);
      localStorage.setItem(BIAS_KEY, String(Math.round(this.player.drift.seekBiasMs)));
    }, 2000);
  }

  // ---- state -------------------------------------------------------------

  serverNow(): number {
    return this.conn.serverNow();
  }

  private catalog(index: LibraryIndex | undefined): Catalog | undefined {
    if (!index) return undefined;
    return (id) => index.tracks.get(id)?.durationMs;
  }

  /** Effective state: the server state unless a local change is pending. */
  effectiveState(): RoomState {
    const o = this.optimistic;
    if (o && (Date.now() > o.expires || this.conn.state.version > o.baseVersion)) this.optimistic = undefined;
    return this.optimistic?.state ?? this.conn.state;
  }

  /** The room state advanced to `now`, following the timeline offline. */
  stateAt(now: number): RoomState {
    const s = this.effectiveState();
    const cat = this.catalog(useLibrary.getState().index);
    return cat ? normalize(s, now, cat).state : s;
  }

  target(now: number): Target | undefined {
    const s = this.stateAt(now);
    if (!s.playback.trackId) return undefined;
    return timelineTarget(s, now);
  }

  private onServerState(_s: RoomState): void {
    this.publishState();
    this.saveSnapshotSoon();
    this.updatePrefetch();
    this.player.tick();
  }

  private publishState(): void {
    useRoom.setState({ state: this.effectiveState() });
  }

  private onLibrary(): void {
    const index = useLibrary.getState().index;
    if (!index) return;
    this.downloader.resumePins((id) => refOf(index.tracks.get(id)));
    this.updatePrefetch();
    this.player.tick();
  }

  private async refreshLibrary(announce: boolean): Promise<void> {
    const changed = await useLibrary.getState().refresh(this.db);
    if (changed && announce) useUI.getState().toast(t('libraryUpdated'));
  }

  private updatePrefetch(): void {
    const index = useLibrary.getState().index;
    const cat = this.catalog(index);
    if (!index || !cat) return;
    const s = this.stateAt(this.serverNow());
    const ids = [s.playback.trackId, ...upcoming(s, useSettings.getState().prefetch, cat)].filter(Boolean);
    const refs = [...new Set(ids)].map((id) => refOf(index.tracks.get(id))).filter((r): r is TrackRef => !!r);
    this.downloader.setPrefetch(refs);
  }

  private async resolveSource(id: string, bypassCache: boolean): Promise<Source | undefined> {
    await this.downloader.whenReady();
    if (!bypassCache && this.downloader.isDownloaded(id)) {
      const blob = await this.downloader.blob(id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        return { url, cached: true, release: () => URL.revokeObjectURL(url) };
      }
    }
    const track = useLibrary.getState().index?.tracks.get(id);
    if (!track || navigator.onLine === false) return undefined;
    return {
      url: audioUrl(track, { format: this.format, quality: useSettings.getState().quality }),
      cached: false,
    };
  }

  private onTrackEnded(id: string): void {
    // Only needed when the server does not know the track length.
    const s = this.stateAt(this.serverNow());
    if (s.playback.trackId === id && s.playback.durationMs <= 0) {
      void this.send({
        op: 'ended',
        trackId: id,
        ...(s.playback.entryId ? { entryId: s.playback.entryId } : {}),
      });
    }
  }

  // ---- status & media session ---------------------------------------------

  private statusSoon: ReturnType<typeof setTimeout> | undefined;

  private reportStatusSoon(): void {
    if (this.statusSoon) return;
    this.statusSoon = setTimeout(() => {
      this.statusSoon = undefined;
      this.reportStatus();
    }, 300);
  }

  private reportStatus(): void {
    const p = useRoom.getState().player;
    const s = this.stateAt(this.serverNow());
    const drift = p.driftMs;
    const rtt = this.conn.clock.lastRtt;
    this.conn.sendStatus({
      trackId: p.trackId,
      ...(s.playback.entryId ? { entryId: s.playback.entryId } : {}),
      ready: p.ready,
      buffering: p.buffering,
      playing: p.audible,
      ...(drift !== undefined ? { driftMs: Math.round(drift) } : {}),
      ...(rtt !== undefined ? { rttMs: Math.round(rtt) } : {}),
      offline: this.downloader.stats().tracks,
    });
  }

  private updateMediaSession(): void {
    const index = useLibrary.getState().index;
    const now = this.serverNow();
    const s = this.stateAt(now);
    const track = index?.tracks.get(s.playback.trackId);
    setMediaMetadata(
      track
        ? {
            title: track.title,
            artist: track.artist ?? '',
            album: track.album ?? track.folder,
            ...(track.cover ? { artwork: coverUrl(track.id, track.rev, 512) } : {}),
          }
        : undefined,
    );
    const p = useRoom.getState().player;
    setMediaPlaybackState(
      p.audible || (s.playback.playing && !p.personalPause),
      positionAt(s.playback, now),
      s.playback.durationMs,
    );
  }

  // ---- commands ------------------------------------------------------------

  private usable(): boolean {
    return this.conn.status === 'online' || Date.now() - this.lastOnlineAt < RECONNECT_GRACE_MS;
  }

  private async send(cmd: Command): Promise<Ack> {
    const ack = await this.conn.send(cmd);
    if (!ack.ok) {
      this.optimistic = undefined;
      this.publishState();
      this.player.tick();
      if (ack.error?.code !== 'expired' && ack.error?.code !== 'stopped') {
        useUI.getState().toast(t('commandFailed', { reason: ack.error?.message ?? '' }));
      }
    }
    return ack;
  }

  private sendOrWarn(cmd: Command): Promise<Ack | undefined> {
    if (!this.usable()) {
      useUI.getState().toast(t('offlineControls'));
      return Promise.resolve(undefined);
    }
    return this.send(cmd);
  }

  private applyOptimistic(change: (s: RoomState, now: number) => void): void {
    const now = this.serverNow();
    const base = this.stateAt(now);
    const next: RoomState = { ...base, playback: { ...base.playback } };
    change(next, now);
    this.optimistic = {
      state: next,
      baseVersion: this.conn.state.version,
      expires: Date.now() + OPTIMISTIC_TTL_MS,
    };
    this.publishState();
    this.player.tick();
  }

  private resumeDelay(): number {
    return this.conn.welcome?.timing.resumeDelayMs ?? 400;
  }

  /** In-app play button: resumes the room (and this phone). */
  async play(): Promise<void> {
    this.player.unlock();
    const personal = useRoom.getState().player.personalPause;
    this.player.setPersonalPause(false);
    const s = this.stateAt(this.serverNow());
    if (s.playback.playing) return;
    if (!this.usable()) {
      if (!personal) useUI.getState().toast(t('offlineControls'));
      return;
    }
    if (s.playback.trackId) {
      this.applyOptimistic((st, now) => {
        st.playback.playing = true;
        st.playback.anchorMs = now + this.resumeDelay();
      });
    }
    await this.send({ op: 'play' });
  }

  /** In-app pause button: pauses the room, or only this phone when offline. */
  async pause(): Promise<void> {
    if (!this.usable()) {
      this.player.setPersonalPause(true);
      return;
    }
    const now = this.serverNow();
    const pos = Math.round(positionAt(this.stateAt(now).playback, now));
    this.applyOptimistic((st, n) => {
      st.playback.playing = false;
      st.playback.positionMs = pos;
      st.playback.anchorMs = n;
    });
    await this.send({ op: 'pause', positionMs: pos });
  }

  togglePlay(): Promise<void> {
    const p = useRoom.getState().player;
    const s = this.stateAt(this.serverNow());
    return s.playback.playing && !p.personalPause ? this.pause() : this.play();
  }

  /** Leaves a personal pause and follows the room again. */
  resumeWithRoom(): void {
    this.player.unlock();
    this.player.setPersonalPause(false);
  }

  private mediaPlay(): void {
    if (useSettings.getState().headsetControls === 'room') void this.play();
    else this.resumeWithRoom();
  }

  private mediaPause(): void {
    if (useSettings.getState().headsetControls === 'room') void this.pause();
    else this.player.setPersonalPause(true);
  }

  async seek(positionMs: number): Promise<void> {
    if (!this.usable()) {
      useUI.getState().toast(t('offlineControls'));
      return;
    }
    const pos = Math.max(0, Math.round(positionMs));
    this.applyOptimistic((st, now) => {
      st.playback.positionMs = pos;
      st.playback.anchorMs = st.playback.playing ? now + this.resumeDelay() : now;
    });
    await this.send({ op: 'seek', positionMs: pos });
  }

  next = () => this.sendOrWarn({ op: 'next' });
  prev = () => this.sendOrWarn({ op: 'prev' });
  jump = (index: number) => this.sendOrWarn({ op: 'jump', index });
  playEntry = (entryId: string) => this.sendOrWarn({ op: 'playEntry', entryId });
  queueAdd = (trackIds: string[], next = false) => this.sendOrWarn({ op: 'queueAdd', trackIds, next });
  queueRemove = (entryId: string) => this.sendOrWarn({ op: 'queueRemove', entryId });
  queueMove = (entryId: string, toIndex: number) => this.sendOrWarn({ op: 'queueMove', entryId, toIndex });
  queueClear = () => this.sendOrWarn({ op: 'queueClear' });
  setShuffle = (on: boolean) => this.sendOrWarn({ op: 'shuffle', on });
  setRepeat = (mode: Repeat) => this.sendOrWarn({ op: 'repeat', mode });
  setWaitForAll = (on: boolean) => this.sendOrWarn({ op: 'waitForAll', on });

  playContext(context: ContextSpec, startIndex?: number): Promise<Ack | undefined> {
    this.player.unlock();
    this.player.setPersonalPause(false);
    return this.sendOrWarn({
      op: 'playContext',
      context,
      ...(startIndex !== undefined ? { startIndex } : {}),
    });
  }

  /**
   * Snapshot for diagnostics and end-to-end tests: where the element is
   * compared with where the room timeline says it should be.
   */
  debugInfo() {
    const now = this.serverNow();
    const tgt = this.target(now);
    const latency = useSettings.getState().latencyMs;
    return {
      serverNow: now,
      trackId: tgt?.trackId ?? '',
      targetMs: tgt ? tgt.positionMs - tgt.startsInMs + latency : 0,
      elementMs: this.player.elementMs,
      paused: this.player.elementPaused,
      playing: tgt?.playing ?? false,
      offsetMs: this.conn.clock.offset,
      rttMs: this.conn.clock.rtt,
      seekBiasMs: this.player.drift.seekBiasMs,
      status: this.conn.status,
      downloaded: this.downloader.downloadedIds(),
    };
  }

  /** Takes over after the app was opened in another tab. */
  takeOver(): void {
    useRoom.setState({ halted: undefined });
    this.conn.restart();
  }
}

export function refOf(t: LibraryTrack | undefined): TrackRef | undefined {
  return t ? { id: t.id, rev: t.rev } : undefined;
}

let engine: Engine | undefined;

/** The app-wide engine (created on first use). */
export function getEngine(): Engine {
  engine ??= new Engine();
  return engine;
}

/** Replaces the singleton (tests). */
export function setEngineForTests(e: Engine | undefined): void {
  engine = e;
}

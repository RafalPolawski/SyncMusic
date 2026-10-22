import { ArrowLeft, CheckCircle2, Download, Loader2, Play, Shuffle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LibraryTrack } from '../../api';
import { getEngine, refOf } from '../../engine';
import { requestPersistentStorage } from '../../offline/db';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { useRoom } from '../../store/room';
import type { ContextSpec } from '../../sync/protocol';
import { formatTime, useDownloads } from '../hooks';
import { Cover } from './Cover';
import { TrackRow } from './TrackRow';

/** Download toggle for a whole folder or playlist. */
export function DownloadToggle({ pinKey, trackIds }: { pinKey: string; trackIds: string[] }) {
  const t = useT();
  const dl = useDownloads();
  const index = useLibrary((s) => s.index);
  const pinned = dl.isPinned(pinKey);
  const st = dl.collectionStatus(trackIds);
  const done = st.downloaded === st.total && st.total > 0;
  const toggle = async () => {
    if (pinned) {
      await dl.unpin(pinKey);
      return;
    }
    void requestPersistentStorage();
    const refs = trackIds.map((id) => refOf(index?.tracks.get(id))).filter((r) => r !== undefined);
    await dl.pin(pinKey, refs);
  };
  const label = pinned
    ? done
      ? t('downloaded')
      : t('downloading', { done: st.downloaded, total: st.total })
    : t('download');
  return (
    <button
      type="button"
      className={`chip ${pinned ? 'is-active' : ''}`}
      aria-pressed={pinned}
      onClick={() => void toggle()}
      title={pinned ? t('removeDownload') : t('download')}
    >
      {pinned && done ? (
        <CheckCircle2 size={16} />
      ) : pinned ? (
        <Loader2 size={16} className={st.active ? 'spin' : ''} />
      ) : (
        <Download size={16} />
      )}
      <span>{label}</span>
    </button>
  );
}

interface CollectionProps {
  title: string;
  subtitle?: string;
  context: ContextSpec;
  /** Tracks listed on this page (may be a subset of the context, e.g. folder files). */
  tracks: LibraryTrack[];
  pinKey: string;
  coverTrackId?: string | undefined;
  onBack?: () => void;
  children?: ReactNode;
  showFolder?: boolean;
}

export function Collection({
  title,
  subtitle,
  context,
  tracks,
  pinKey,
  coverTrackId,
  onBack,
  children,
  showFolder,
}: CollectionProps) {
  const t = useT();
  const shuffle = useRoom((s) => s.state.shuffle);
  const engine = getEngine();
  const total = context.tracks.reduce(
    (s, id) => s + (useLibrary.getState().index?.tracks.get(id)?.durationMs ?? 0),
    0,
  );
  const playAt = (trackId?: string) => {
    const idx = trackId ? context.tracks.indexOf(trackId) : undefined;
    void engine.playContext(context, idx !== undefined && idx >= 0 ? idx : undefined);
  };
  return (
    <div className="collection">
      <header className="collection-header">
        {onBack && (
          <button type="button" className="icon-btn back" aria-label="back" onClick={onBack}>
            <ArrowLeft size={22} />
          </button>
        )}
        <Cover trackId={coverTrackId} size={512} label={title} className="cover-lg" />
        <div className="collection-info">
          <h1>{title}</h1>
          <p className="muted">
            {subtitle ? subtitle + ' · ' : ''}
            {t('tracksCount', { n: context.tracks.length })} · {formatTime(total)}
          </p>
        </div>
        <div className="collection-actions">
          <button
            type="button"
            className="btn primary"
            disabled={context.tracks.length === 0}
            onClick={() => {
              if (shuffle) void engine.setShuffle(false);
              playAt();
            }}
          >
            <Play size={18} fill="currentColor" /> {t('play')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={context.tracks.length === 0}
            onClick={async () => {
              if (!shuffle) await engine.setShuffle(true);
              playAt();
            }}
          >
            <Shuffle size={18} /> {t('shufflePlay')}
          </button>
          <DownloadToggle pinKey={pinKey} trackIds={context.tracks} />
        </div>
      </header>
      {children}
      <div className="track-list">
        {tracks.map((tr) => (
          <TrackRow key={tr.id} track={tr} onPlay={() => playAt(tr.id)} showFolder={showFolder} />
        ))}
      </div>
    </div>
  );
}

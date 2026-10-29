import { CheckCircle2, CloudOff, Download, EllipsisVertical, ListEnd, ListPlus } from 'lucide-react';
import { memo, useState } from 'react';
import type { LibraryTrack } from '../../api';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useRoom } from '../../store/room';
import { formatTime, useDownloads } from '../hooks';
import { Cover } from './Cover';
import { Sheet, SheetItem } from './Sheet';

interface Props {
  track: LibraryTrack;
  onPlay: () => void;
  showFolder?: boolean;
}

export const TrackRow = memo(function TrackRow({ track, onPlay, showFolder }: Props) {
  const t = useT();
  const [menu, setMenu] = useState(false);
  const current = useRoom((s) => s.state.playback.trackId === track.id);
  const online = useRoom((s) => s.status === 'online');
  const dl = useDownloads();
  const downloaded = dl.isDownloaded(track.id);
  const progress = dl.progress(track.id);
  const sub = [track.artist, showFolder ? track.folder : track.album].filter(Boolean).join(' · ');
  return (
    <>
      <div
        className={`track-row ${current ? 'is-current' : ''} ${!online && !downloaded ? 'is-unavailable' : ''}`}
      >
        <button type="button" className="track-main" onClick={onPlay}>
          <Cover trackId={track.id} className="cover-sm" />
          <span className="track-text">
            <span className="track-title">{track.title}</span>
            <span className="track-sub">{sub}</span>
          </span>
        </button>
        <span className="track-meta">
          {progress ? (
            <span className="track-progress" title={t('downloading', { done: 0, total: 1 })}>
              {Math.round((progress.loaded / Math.max(1, progress.total)) * 100)}%
            </span>
          ) : downloaded ? (
            <CheckCircle2 size={14} className="icon-ok" aria-label={t('downloaded')} />
          ) : !online ? (
            <CloudOff size={14} aria-label={t('unavailableOffline')} />
          ) : null}
          <span className="track-duration">{formatTime(track.durationMs)}</span>
        </span>
        <button type="button" className="icon-btn" aria-label="⋯" onClick={() => setMenu(true)}>
          <EllipsisVertical size={18} />
        </button>
      </div>
      <Sheet open={menu} onClose={() => setMenu(false)} title={track.title}>
        <SheetItem
          icon={<ListPlus size={20} />}
          label={t('playNext')}
          onClick={() => {
            setMenu(false);
            void getEngine().queueAdd([track.id], true);
          }}
        />
        <SheetItem
          icon={<ListEnd size={20} />}
          label={t('addToQueue')}
          onClick={() => {
            setMenu(false);
            void getEngine().queueAdd([track.id]);
          }}
        />
        {!downloaded && (
          <SheetItem
            icon={<Download size={20} />}
            label={t('download')}
            onClick={() => {
              setMenu(false);
              void getEngine().downloader.pin('track:' + track.id, [{ id: track.id, rev: track.rev }]);
            }}
          />
        )}
      </Sheet>
    </>
  );
});

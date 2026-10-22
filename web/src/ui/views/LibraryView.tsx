import { ChevronRight, Disc3, FolderOpen, ListMusic, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type ScanStatus } from '../../api';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { useRoom } from '../../store/room';
import { useDownloads } from '../hooks';
import { navigate } from '../router';
import { Cover } from '../components/Cover';

function OfflineDot({ trackIds, pinKey }: { trackIds: string[]; pinKey: string }) {
  const dl = useDownloads();
  if (!dl.isPinned(pinKey)) return null;
  const st = dl.collectionStatus(trackIds);
  return <span className={`dot ${st.downloaded === st.total ? 'dot-ok' : 'dot-busy'}`} aria-hidden />;
}

export function LibraryView() {
  const t = useT();
  const index = useLibrary((s) => s.index);
  const online = useRoom((s) => s.status === 'online');
  const [scan, setScan] = useState<ScanStatus | undefined>(undefined);

  useEffect(() => {
    if (!online || (index && index.data.tracks.length > 0)) return;
    let stop = false;
    const poll = async () => {
      try {
        const s = await api.scanStatus();
        if (!stop) setScan(s);
        if (!stop && s.scanning) setTimeout(poll, 1000);
        else if (!stop) await useLibrary.getState().refresh(getEngine().db);
      } catch {
        // ignore
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [online, index]);

  if (!index) return <div className="empty">{t('loading')}</div>;
  const folders = index.children.get('') ?? [];
  const root = index.folders.get('');
  const loose = root?.trackIds ?? [];
  const playlists = index.data.playlists;

  if (index.data.tracks.length === 0) {
    return (
      <div className="empty">
        <Disc3 size={48} />
        <p>
          {scan?.scanning ? t('scanning', { done: scan.processed, total: scan.total }) : t('emptyLibrary')}
        </p>
        {online && !scan?.scanning && (
          <button type="button" className="btn" onClick={() => void api.rescan().then(setScan)}>
            <RefreshCw size={16} /> {t('rescan')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="library">
      <button type="button" className="list-item" onClick={() => navigate({ name: 'all' })}>
        <span className="list-icon">
          <ListMusic size={22} />
        </span>
        <span className="list-text">
          <span className="list-title">{t('allTracks')}</span>
          <span className="list-sub">{t('tracksCount', { n: index.data.tracks.length })}</span>
        </span>
        <ChevronRight size={18} className="muted" />
      </button>

      {folders.length > 0 && <h2 className="section-title">{t('folders')}</h2>}
      <div className="grid">
        {folders.map((f) => {
          const ids = index.deepTracks(f.path);
          return (
            <button
              key={f.path}
              type="button"
              className="tile"
              onClick={() => navigate({ name: 'folder', path: f.path })}
            >
              <Cover
                trackId={f.coverTrackId ?? findCover(index, ids)}
                size={512}
                label={f.name}
                className="cover-tile"
              />
              <span className="tile-title">
                <OfflineDot trackIds={ids} pinKey={'folder:' + f.path} />
                {f.name}
              </span>
              <span className="tile-sub">{t('tracksCount', { n: ids.length })}</span>
            </button>
          );
        })}
      </div>

      {loose.length > 0 && (
        <button type="button" className="list-item" onClick={() => navigate({ name: 'folder', path: '' })}>
          <span className="list-icon">
            <FolderOpen size={22} />
          </span>
          <span className="list-text">
            <span className="list-title">
              <OfflineDot trackIds={loose} pinKey="folder:" />
              {t('looseTracks')}
            </span>
            <span className="list-sub">{t('tracksCount', { n: loose.length })}</span>
          </span>
          <ChevronRight size={18} className="muted" />
        </button>
      )}

      {playlists.length > 0 && <h2 className="section-title">{t('playlists')}</h2>}
      {playlists.map((p) => (
        <button
          key={p.id}
          type="button"
          className="list-item"
          onClick={() => navigate({ name: 'playlist', id: p.id })}
        >
          <Cover trackId={findCover(index, p.trackIds)} label={p.name} className="cover-sm" />
          <span className="list-text">
            <span className="list-title">
              <OfflineDot trackIds={p.trackIds} pinKey={'playlist:' + p.id} />
              {p.name}
            </span>
            <span className="list-sub">{t('tracksCount', { n: p.trackIds.length })}</span>
          </span>
          <ChevronRight size={18} className="muted" />
        </button>
      ))}
    </div>
  );
}

function findCover(
  index: NonNullable<ReturnType<typeof useLibrary.getState>['index']>,
  ids: string[],
): string | undefined {
  return ids.find((id) => index.tracks.get(id)?.cover);
}

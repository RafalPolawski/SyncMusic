import { ChevronRight, Folder } from 'lucide-react';
import type { LibraryTrack } from '../../api';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { Collection } from '../components/Collection';
import { navigate } from '../router';

function tracksOf(ids: string[], map: Map<string, LibraryTrack>): LibraryTrack[] {
  return ids.map((id) => map.get(id)).filter((x): x is LibraryTrack => !!x);
}

function back() {
  if (history.length > 1) history.back();
  else navigate({ name: 'library' });
}

export function FolderView({ path }: { path: string }) {
  const t = useT();
  const index = useLibrary((s) => s.index);
  if (!index) return <div className="empty">{t('loading')}</div>;
  const folder = index.folders.get(path);
  if (!folder) return <div className="empty">{t('noResults')}</div>;
  // The root folder holds only loose files; other folders include subfolders.
  const contextIds = path === '' ? folder.trackIds : index.deepTracks(path);
  const subfolders = path === '' ? [] : (index.children.get(path) ?? []);
  const name = path === '' ? t('looseTracks') : folder.name;
  return (
    <Collection
      title={name}
      subtitle={folder.parent ? folder.parent : undefined}
      context={{ kind: 'folder', id: path, name, tracks: contextIds }}
      tracks={tracksOf(folder.trackIds, index.tracks)}
      pinKey={'folder:' + path}
      coverTrackId={folder.coverTrackId ?? contextIds.find((id) => index.tracks.get(id)?.cover)}
      onBack={back}
    >
      {subfolders.length > 0 && (
        <div className="subfolders">
          {subfolders.map((f) => (
            <button
              key={f.path}
              type="button"
              className="list-item"
              onClick={() => navigate({ name: 'folder', path: f.path })}
            >
              <span className="list-icon">
                <Folder size={20} />
              </span>
              <span className="list-text">
                <span className="list-title">{f.name}</span>
                <span className="list-sub">{t('tracksCount', { n: index.deepTracks(f.path).length })}</span>
              </span>
              <ChevronRight size={18} className="muted" />
            </button>
          ))}
        </div>
      )}
    </Collection>
  );
}

export function PlaylistView({ id }: { id: string }) {
  const t = useT();
  const index = useLibrary((s) => s.index);
  if (!index) return <div className="empty">{t('loading')}</div>;
  const pl = index.playlists.get(id);
  if (!pl) return <div className="empty">{t('noResults')}</div>;
  return (
    <Collection
      title={pl.name}
      context={{ kind: 'playlist', id: pl.id, name: pl.name, tracks: pl.trackIds }}
      tracks={tracksOf(pl.trackIds, index.tracks)}
      pinKey={'playlist:' + pl.id}
      coverTrackId={pl.trackIds.find((x) => index.tracks.get(x)?.cover)}
      onBack={back}
      showFolder
    />
  );
}

export function AllTracksView() {
  const t = useT();
  const index = useLibrary((s) => s.index);
  if (!index) return <div className="empty">{t('loading')}</div>;
  const ids = index.data.tracks.map((x) => x.id);
  return (
    <Collection
      title={t('allTracks')}
      context={{ kind: 'library', id: '', name: t('allTracks'), tracks: ids }}
      tracks={index.data.tracks}
      pinKey="library:"
      onBack={back}
      showFolder
    />
  );
}

import { ChevronDown, ListMusic } from 'lucide-react';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { useRoom } from '../../store/room';
import { usePosition } from '../hooks';
import { closePlayer, navigate } from '../router';
import { Controls } from './Controls';
import { Cover } from './Cover';
import { ProgressBar } from './ProgressBar';
import { Listeners, SyncLine } from './Status';

export function NowPlaying() {
  const t = useT();
  const pos = usePosition();
  const track = useLibrary((s) => s.index?.tracks.get(pos.trackId));
  const contextName = useRoom((s) => s.state.context.name);
  const personal = useRoom((s) => s.player.personalPause && s.state.playback.playing);
  const unavailable = useRoom((s) => s.player.unavailable);
  const buffering = useRoom((s) => s.player.buffering && s.state.playback.playing);
  return (
    <div className="now-playing" role="dialog" aria-modal="true" aria-label={t('nowPlaying')}>
      <header className="np-header">
        <button type="button" className="icon-btn" aria-label="close" onClick={closePlayer}>
          <ChevronDown size={28} />
        </button>
        <div className="np-context">
          <small>{t('nowPlaying')}</small>
          <span>{contextName}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('tabQueue')}
          onClick={() => {
            closePlayer();
            setTimeout(() => navigate({ name: 'queue' }), 0);
          }}
        >
          <ListMusic size={24} />
        </button>
      </header>
      {pos.trackId ? (
        <>
          <Cover trackId={pos.trackId} size={512} className="cover-xl" />
          <div className="np-title">
            <h2>{track?.title ?? '…'}</h2>
            <p>{[track?.artist, track?.album].filter(Boolean).join(' · ')}</p>
          </div>
          <ProgressBar />
          <Controls />
          <div className="np-status">
            {personal ? (
              <button type="button" className="pill" onClick={() => getEngine().resumeWithRoom()}>
                {t('personalPaused')} · {t('resumeWithRoom')}
              </button>
            ) : unavailable ? (
              <span className="pill warn">{t('unavailableOffline')}</span>
            ) : pos.startsInMs > 300 ? (
              <span className="pill">{t('startingIn', { s: Math.ceil(pos.startsInMs / 1000) })}</span>
            ) : buffering ? (
              <span className="pill">{t('buffering')}</span>
            ) : null}
            <SyncLine />
          </div>
          <Listeners />
        </>
      ) : (
        <div className="empty">
          <p>{t('nothingPlaying')}</p>
          <p className="muted">{t('pickSomething')}</p>
        </div>
      )}
    </div>
  );
}

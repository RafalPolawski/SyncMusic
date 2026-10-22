import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { useRoom } from '../../store/room';
import { usePosition } from '../hooks';
import { openPlayer } from '../router';
import { Cover } from './Cover';
import { PlayPauseButton } from './Controls';
import { ProgressLine } from './ProgressBar';

export function MiniPlayer() {
  const t = useT();
  const { trackId } = usePosition();
  const personal = useRoom((s) => s.player.personalPause && s.state.playback.playing);
  const track = useLibrary((s) => s.index?.tracks.get(trackId));
  if (!trackId) return null;
  return (
    <div className="mini-player">
      <ProgressLine />
      <div
        className="mini-row"
        role="button"
        tabIndex={0}
        onClick={openPlayer}
        onKeyDown={(e) => e.key === 'Enter' && openPlayer()}
      >
        <Cover trackId={trackId} className="cover-sm" />
        <div className="mini-text">
          <div className="mini-title">{track?.title ?? '…'}</div>
          <div className="mini-sub">
            {personal ? (
              <button
                type="button"
                className="link-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  getEngine().resumeWithRoom();
                }}
              >
                {t('personalPaused')} · {t('resumeWithRoom')}
              </button>
            ) : (
              (track?.artist ?? '')
            )}
          </div>
        </div>
        <PlayPauseButton size={24} />
      </div>
    </div>
  );
}

import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useRoom } from '../../store/room';
import type { Repeat as RepeatMode } from '../../sync/protocol';

const nextRepeat: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

export function PlayPauseButton({
  size = 28,
  className = 'play-btn',
}: {
  size?: number;
  className?: string;
}) {
  const t = useT();
  const playing = useRoom((s) => s.state.playback.playing);
  const personal = useRoom((s) => s.player.personalPause);
  const buffering = useRoom((s) => s.player.buffering && s.state.playback.playing);
  const active = playing && !personal;
  return (
    <button
      type="button"
      className={className}
      aria-label={active ? t('pause') : t('play')}
      onClick={(e) => {
        e.stopPropagation();
        void getEngine().togglePlay();
      }}
    >
      {active && buffering ? (
        <Loader2 size={size} className="spin" />
      ) : active ? (
        <Pause size={size} fill="currentColor" />
      ) : (
        <Play size={size} fill="currentColor" />
      )}
    </button>
  );
}

export function Controls() {
  const t = useT();
  const shuffle = useRoom((s) => s.state.shuffle);
  const repeat = useRoom((s) => s.state.repeat);
  const e = getEngine();
  const repeatLabel = { off: t('repeatOff'), all: t('repeatAll'), one: t('repeatOne') }[repeat];
  return (
    <div className="controls">
      <button
        type="button"
        className={`icon-btn ${shuffle ? 'is-active' : ''}`}
        aria-label={t('shuffle')}
        aria-pressed={shuffle}
        onClick={() => void e.setShuffle(!shuffle)}
      >
        <Shuffle size={22} />
      </button>
      <button type="button" className="icon-btn big" aria-label={t('previous')} onClick={() => void e.prev()}>
        <SkipBack size={30} fill="currentColor" />
      </button>
      <PlayPauseButton size={34} className="play-btn play-btn-lg" />
      <button type="button" className="icon-btn big" aria-label={t('next')} onClick={() => void e.next()}>
        <SkipForward size={30} fill="currentColor" />
      </button>
      <button
        type="button"
        className={`icon-btn ${repeat !== 'off' ? 'is-active' : ''}`}
        aria-label={repeatLabel}
        title={repeatLabel}
        onClick={() => void e.setRepeat(nextRepeat[repeat])}
      >
        {repeat === 'one' ? <Repeat1 size={22} /> : <Repeat size={22} />}
      </button>
    </div>
  );
}

import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useLibrary } from '../../store/library';
import { useRoom } from '../../store/room';
import { Cover } from '../components/Cover';
import { formatTime, usePosition } from '../hooks';

const CONTEXT_PREVIEW = 30;

export function QueueView() {
  const t = useT();
  const index = useLibrary((s) => s.index);
  useRoom((s) => s.state.version);
  usePosition(); // follow automatic advances while offline
  const engine = getEngine();
  const state = engine.stateAt(engine.serverNow());
  const current = index?.tracks.get(state.playback.trackId);
  const order = state.context.order;
  const upcoming: { orderIdx: number; trackId: string }[] = [];
  const n = order.length;
  for (let i = 1; i <= Math.min(CONTEXT_PREVIEW, n); i++) {
    let idx = state.contextIndex + i;
    if (idx >= n) {
      if (state.repeat !== 'all') break;
      idx %= n;
    }
    upcoming.push({ orderIdx: idx, trackId: state.context.tracks[order[idx]!]! });
  }

  return (
    <div className="queue">
      <h2 className="section-title">{t('nowPlaying')}</h2>
      {current ? (
        <div className="queue-row is-current">
          <Cover trackId={current.id} className="cover-sm" />
          <span className="track-text">
            <span className="track-title">{current.title}</span>
            <span className="track-sub">{current.artist}</span>
          </span>
        </div>
      ) : (
        <p className="muted pad">{t('nothingPlaying')}</p>
      )}

      <div className="section-row">
        <h2 className="section-title">{t('upNext')}</h2>
        {state.queue.length > 0 && (
          <button type="button" className="chip" onClick={() => void engine.queueClear()}>
            <Trash2 size={14} /> {t('clearQueue')}
          </button>
        )}
      </div>
      {state.queue.length === 0 && <p className="muted pad">{t('queueEmpty')}</p>}
      {state.queue.map((q, i) => {
        const tr = index?.tracks.get(q.trackId);
        return (
          <div key={q.id} className="queue-row">
            <button type="button" className="track-main" onClick={() => void engine.playEntry(q.id)}>
              <Cover trackId={q.trackId} className="cover-sm" />
              <span className="track-text">
                <span className="track-title">{tr?.title ?? q.trackId}</span>
                <span className="track-sub">
                  {[tr?.artist, q.addedBy ? t('addedBy', { name: q.addedBy }) : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('moveUp')}
              disabled={i === 0}
              onClick={() => void engine.queueMove(q.id, i - 1)}
            >
              <ArrowUp size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('moveDown')}
              disabled={i === state.queue.length - 1}
              onClick={() => void engine.queueMove(q.id, i + 1)}
            >
              <ArrowDown size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('removeFromQueue')}
              onClick={() => void engine.queueRemove(q.id)}
            >
              <X size={18} />
            </button>
          </div>
        );
      })}

      {upcoming.length > 0 && (
        <h2 className="section-title">{t('nextFrom', { name: state.context.name })}</h2>
      )}
      {upcoming.map((u) => {
        const tr = index?.tracks.get(u.trackId);
        return (
          <button
            key={`${u.orderIdx}-${u.trackId}`}
            type="button"
            className="queue-row"
            onClick={() => void engine.jump(u.orderIdx)}
          >
            <Cover trackId={u.trackId} className="cover-sm" />
            <span className="track-text">
              <span className="track-title">{tr?.title ?? u.trackId}</span>
              <span className="track-sub">{tr?.artist}</span>
            </span>
            <span className="track-duration">{tr ? formatTime(tr.durationMs) : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

import { useRef, useState, type PointerEvent } from 'react';
import { getEngine } from '../../engine';
import { formatTime, usePosition } from '../hooks';

/** Seekable progress bar. Dragging previews locally; release seeks the room. */
export function ProgressBar() {
  const pos = usePosition();
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | undefined>(undefined);
  const duration = pos.durationMs;
  const shown = drag ?? pos.positionMs;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  const at = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration;
  };

  return (
    <div className="progress">
      <div
        ref={bar}
        className="progress-track"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(shown / 1000)}
        tabIndex={0}
        onPointerDown={(e) => {
          if (!duration) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(at(e));
        }}
        onPointerMove={(e) => drag !== undefined && setDrag(at(e))}
        onPointerUp={(e) => {
          if (drag === undefined) return;
          const target = at(e);
          setDrag(undefined);
          void getEngine().seek(target);
        }}
        onPointerCancel={() => setDrag(undefined)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') void getEngine().seek(pos.positionMs + 10_000);
          if (e.key === 'ArrowLeft') void getEngine().seek(pos.positionMs - 10_000);
        }}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
        <div className="progress-thumb" style={{ left: `${pct}%` }} />
      </div>
      <div className="progress-times">
        <span>{formatTime(shown)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

/** Thin, non-interactive progress line for the mini player. */
export function ProgressLine() {
  const pos = usePosition();
  const pct = pos.durationMs > 0 ? Math.min(100, (pos.positionMs / pos.durationMs) * 100) : 0;
  return (
    <div className="progress-line">
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

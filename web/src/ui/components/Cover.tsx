import { useState } from 'react';
import { coverUrl } from '../../api';
import { useLibrary } from '../../store/library';

interface Props {
  trackId?: string | undefined;
  size?: 128 | 512;
  label?: string;
  className?: string;
}

/** Album art with a generated placeholder when none is available. */
export function Cover({ trackId, size = 128, label = '', className = '' }: Props) {
  const track = useLibrary((s) => (trackId ? s.index?.tracks.get(trackId) : undefined));
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const src = track?.cover ? coverUrl(track.id, track.rev, size) : undefined;
  const text = label || track?.album || track?.title || '♪';
  if (src && failed !== src) {
    return (
      <img
        className={`cover ${className}`}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(src)}
      />
    );
  }
  return (
    <div
      className={`cover cover-placeholder ${className}`}
      style={{ background: gradientFor(text) }}
      aria-hidden
    >
      <span>{initials(text)}</span>
    </div>
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function gradientFor(s: string): string {
  const h = hash(s) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 32%), hsl(${(h + 50) % 360} 60% 18%))`;
}

function initials(s: string): string {
  const words = s
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '♪';
  return (words[0]![0]! + (words[1]?.[0] ?? '')).toUpperCase();
}

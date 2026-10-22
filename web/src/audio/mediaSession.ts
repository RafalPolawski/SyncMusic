// Lock screen / notification integration (Media Session API).

export interface MediaInfo {
  title: string;
  artist: string;
  album: string;
  artwork?: string;
}

export interface MediaHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(ms: number): void;
}

function session(): MediaSession | undefined {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : undefined;
}

export function setMediaHandlers(h: MediaHandlers): void {
  const ms = session();
  if (!ms) return;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // action not supported by this browser
    }
  };
  set('play', () => h.play());
  set('pause', () => h.pause());
  set('nexttrack', () => h.next());
  set('previoustrack', () => h.previous());
  set('seekto', (d) => {
    if (d.seekTime !== undefined) h.seekTo(d.seekTime * 1000);
  });
  set('stop', () => h.pause());
}

let lastKey = '';

export function setMediaMetadata(info: MediaInfo | undefined): void {
  const ms = session();
  if (!ms || typeof MediaMetadata === 'undefined') return;
  const key = JSON.stringify(info ?? null);
  if (key === lastKey) return;
  lastKey = key;
  ms.metadata = info
    ? new MediaMetadata({
        title: info.title,
        artist: info.artist,
        album: info.album,
        artwork: info.artwork ? [{ src: info.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
      })
    : null;
}

export function setMediaPlaybackState(playing: boolean, positionMs?: number, durationMs?: number): void {
  const ms = session();
  if (!ms) return;
  ms.playbackState = playing ? 'playing' : 'paused';
  if (positionMs !== undefined && durationMs && durationMs > 0 && ms.setPositionState) {
    try {
      ms.setPositionState({
        duration: durationMs / 1000,
        position: Math.min(durationMs, Math.max(0, positionMs)) / 1000,
        playbackRate: 1,
      });
    } catch {
      // invalid state during track changes
    }
  }
}

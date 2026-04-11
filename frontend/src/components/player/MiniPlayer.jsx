import React from 'react';
import { Play, Pause, Shuffle, Repeat, SkipBack, SkipForward } from 'lucide-react';
import { motion } from 'framer-motion';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useQueueStore } from '../../store/useQueueStore';
import { socket } from '../../lib/webtransport';
import { playNext, playPrev } from '../../lib/playerActions';

export default function MiniPlayer({ onClick }) {
  const { title, artist, coverUrl, currentPath, isPlaying, isShuffle, isRepeat, currentTime, duration } = usePlayerStore();

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  
  if (!currentPath && !title) return null;

  const handlePlayPause = (e) => {
    e.stopPropagation();
    usePlayerStore.setState({ isPlaying: !isPlaying }); // Optimistic UI
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  const handleNext = (e) => {
    e.stopPropagation();
    playNext();
  };

  const handlePrev = (e) => {
    e.stopPropagation();
    playPrev();
  };

  const toggleShuffle = (e) => {
    e.stopPropagation();
    const newShuffle = !isShuffle;
    usePlayerStore.setState({ isShuffle: newShuffle });
    socket.sendCommand('shuffle', { state: newShuffle });
  };

  const toggleRepeat = (e) => {
    e.stopPropagation();
    const newRepeat = (isRepeat + 1) % 3;
    usePlayerStore.setState({ isRepeat: newRepeat });
    socket.sendCommand('repeat', { state: newRepeat });
  };

  return (
    <div 
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        background: 'rgba(20, 20, 25, 0.95)',
        backdropFilter: 'var(--glass-blur)',
        margin: '8px',
        padding: '8px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.05)',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden'
      }}
    >
      {/* Seekable Progress Bar at top */}
      <div 
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '20px', cursor: 'pointer', zIndex: 1 }}
        onClick={(e) => {
          e.stopPropagation();
          if (!duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          socket.sendCommand('seek', { time: pct * duration });
        }}
      >
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'rgba(255,255,255,0.1)' }}>
          <div style={{ width: `${progressPercent}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.1s linear', position: 'relative' }}>
            <div style={{ position: 'absolute', right: '-4px', top: '50%', transform: 'translateY(-50%)', width: '8px', height: '8px', borderRadius: '50%', background: 'white' }} />
          </div>
        </div>
      </div>
      <img 
        src={coverUrl || '/default-album.png'} 
        alt="Cover" 
        style={{ width: '40px', height: '40px', borderRadius: '6px', objectFit: 'cover' }}
        onError={(e) => { e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23333"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/%3E%3C/svg%3E'; }}
      />
      
      <div style={{ flex: 1, margin: '0 12px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div className="text-ellipsis" style={{ fontWeight: 600, fontSize: '14px', color: 'white' }}>
          {title}
        </div>
        <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
          {artist}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button onClick={toggleShuffle} style={{ padding: '6px', color: isShuffle ? 'var(--primary)' : 'var(--text-tertiary)' }}>
            <Shuffle size={18} />
        </button>
        <button onClick={handlePrev} style={{ padding: '6px', color: 'var(--text-primary)' }}>
            <SkipBack size={20} fill="white" strokeWidth={0} />
        </button>
        <button onClick={handlePlayPause} style={{ padding: '6px', color: 'var(--text-primary)' }}>
            {isPlaying ? <Pause size={24} fill="white" strokeWidth={0} /> : <Play size={24} fill="white" strokeWidth={0} />}
        </button>
        <button onClick={handleNext} style={{ padding: '6px', color: 'var(--text-primary)' }}>
            <SkipForward size={20} fill="white" strokeWidth={0} />
        </button>
        <button onClick={toggleRepeat} style={{ padding: '6px', color: isRepeat > 0 ? 'var(--primary)' : 'var(--text-tertiary)', position: 'relative' }}>
            <Repeat size={18} />
            {isRepeat === 2 && (
                <span style={{ position: 'absolute', top: '2px', right: '2px', fontSize: '7px', fontWeight: 900, background: 'var(--primary)', color: 'var(--bg-base)', borderRadius: '50%', width: '10px', height: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
            )}
        </button>
      </div>
    </div>
  );
}

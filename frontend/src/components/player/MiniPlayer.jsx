import React from 'react';
import { Play, Pause, SkipForward, SkipBack, Shuffle, Repeat } from 'lucide-react';
import { motion } from 'framer-motion';
import { usePlayerStore } from '../../store/usePlayerStore';
import { playNext, playPrev } from '../../lib/playerActions';
import { socket } from '../../lib/webtransport';

const FullBackgroundProgress = React.memo(() => {
  const currentTime = usePlayerStore(state => state.currentTime);
  const duration = usePlayerStore(state => state.duration);
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  
  return (
    <motion.div 
      style={{ 
        position: 'absolute',
        top: 0, left: 0, bottom: 0,
        background: 'var(--primary)',
        opacity: 0.12,
        zIndex: 0,
        pointerEvents: 'none'
      }} 
      animate={{ width: `${progressPercent}%` }}
      transition={{ type: 'tween', ease: 'linear', duration: 0.2 }}
    />
  );
});

export default function MiniPlayer({ onClick }) {
  const title = usePlayerStore(state => state.title);
  const artist = usePlayerStore(state => state.artist);
  const coverUrl = usePlayerStore(state => state.coverUrl);
  const currentPath = usePlayerStore(state => state.currentPath);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const isShuffle = usePlayerStore(state => state.isShuffle);
  const isRepeat = usePlayerStore(state => state.isRepeat);
  const setModes = usePlayerStore(state => state.setModes);

  if (!currentPath && !title) return null;

  const handlePlayPause = (e) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    usePlayerStore.setState({ isPlaying: !isPlaying }); 
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  const handleNext = (e) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    playNext();
  };

  const handlePrev = (e) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    playPrev();
  };

  const toggleShuffle = (e) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    const newShuffle = !isShuffle;
    setModes(newShuffle, isRepeat);
    usePlayerStore.setState({ isShuffle: newShuffle });
    socket.sendCommand('shuffle', { state: newShuffle });
  };

  const toggleRepeat = (e) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    const newRepeat = (isRepeat + 1) % 3;
    setModes(isShuffle, newRepeat);
    usePlayerStore.setState({ isRepeat: newRepeat });
    socket.sendCommand('repeat', { state: newRepeat });
  };

  return (
    <motion.div 
      onClick={onClick}
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="glass-panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        margin: '0 12px 12px 12px',
        padding: '10px 14px',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
      }}
    >
      {/* Animated Full Tile Background Progress */}
      <FullBackgroundProgress />

      <motion.img 
        layoutId="cover-art-large"
        src={coverUrl || '/default-album.png'} 
        alt="" 
        style={{ width: '44px', height: '44px', borderRadius: '10px', objectFit: 'cover', background: 'rgba(255,255,255,0.05)', zIndex: 1 }}
        onError={(e) => { e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23333"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/%3E%3C/svg%3E'; }}
      />
      
      <div style={{ flex: 1, margin: '0 12px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px', zIndex: 1 }}>
        <div className="text-ellipsis" style={{ fontWeight: 700, fontSize: '14px', color: 'white' }}>
          {title}
        </div>
        <div className="text-ellipsis" style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          {artist}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', zIndex: 1 }}>
        <button onClick={toggleShuffle} style={{ padding: '8px', color: isShuffle ? 'var(--primary)' : 'var(--text-tertiary)' }}>
            <Shuffle size={18} />
        </button>
        <button onClick={handlePrev} style={{ padding: '8px', color: 'white' }}>
            <SkipBack size={20} fill="white" strokeWidth={0} />
        </button>
        <button 
          onClick={handlePlayPause} 
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'white', color: 'black', margin: '0 4px' }}
        >
          {isPlaying ? <Pause size={18} fill="black" strokeWidth={0} /> : <Play size={18} fill="black" strokeWidth={0} style={{ marginLeft: '2px' }} />}
        </button>
        <button 
          onClick={handleNext} 
          style={{ padding: '8px', color: 'white' }}
        >
          <SkipForward size={20} fill="white" strokeWidth={0} />
        </button>
        <button onClick={toggleRepeat} style={{ padding: '8px', color: isRepeat > 0 ? 'var(--primary)' : 'var(--text-tertiary)', position: 'relative' }}>
            <Repeat size={18} />
            {isRepeat === 2 && <span style={{ position: 'absolute', top: '4px', right: '4px', fontSize: '8px', fontWeight: 900 }}>1</span>}
        </button>
      </div>
    </motion.div>
  );
}

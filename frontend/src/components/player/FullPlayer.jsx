import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Wifi } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useCacheStore } from '../../store/useCacheStore';
import { socket } from '../../lib/webtransport';
import { playNext, playPrev } from '../../lib/playerActions';
import ProgressBar from './ProgressBar';

export default function FullPlayer({ isOpen, onClose }) {
  const { 
    title, artist, coverUrl, isPlaying, 
    isShuffle, isRepeat, currentPath, setModes, drift 
  } = usePlayerStore();

  const cachedPaths = useCacheStore(state => state.cachedPaths);

  const togglePlay = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(10);
    usePlayerStore.setState({ isPlaying: !isPlaying });
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  // Unified same logic as MiniPlayer + MediaSession
  const handleNext = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(10);
    playNext();
  };

  const handlePrev = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(10);
    playPrev();
  };

  const toggleShuffle = () => {
      if (window.navigator.vibrate) window.navigator.vibrate(10);
      const newShuffle = !isShuffle;
      setModes(newShuffle, isRepeat);
      usePlayerStore.setState({ isShuffle: newShuffle });
      socket.sendCommand('shuffle', { state: newShuffle });
  };

  const toggleRepeat = () => {
      if (window.navigator.vibrate) window.navigator.vibrate(10);
      const newRepeat = (isRepeat + 1) % 3;
      setModes(isShuffle, newRepeat);
      usePlayerStore.setState({ isRepeat: newRepeat });
      socket.sendCommand('repeat', { state: newRepeat });
  };

  const isCached = currentPath && cachedPaths.has(currentPath);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0.2}
          onDragEnd={(e, info) => {
            if (info.offset.y > 150) onClose();
          }}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'radial-gradient(circle at 50% 0%, rgba(var(--dominant-color-rgb), 0.3) 0%, var(--bg-base) 60%)',
            backgroundColor: 'var(--bg-base)',
            display: 'flex', flexDirection: 'column',
            padding: 'env(safe-area-inset-top, 20px) 24px 40px 24px'
          }}
        >
          {/* Top Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
            <motion.button 
              onClick={onClose} 
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              style={{ padding: '8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'white' }}
            >
              <ChevronDown size={32} />
            </motion.button>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '2.5px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>
                NOW PLAYING
              </span>
              {isCached && (
                <span style={{ fontSize: '10px', background: 'var(--primary)', color: 'var(--bg-base)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                  OFFLINE READY
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.05)', padding: '6px 12px', borderRadius: '100px', fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                <Wifi size={14} color={drift > 500 ? '#ff6b6b' : 'var(--primary)'} />
                {drift}ms
              </div>
              <div style={{ width: 48 }} />
            </div>
          </div>

          {/* Cover Art withSwipe Gestures */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0, width: '100%' }}>
            <motion.div
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.2}
              onDragEnd={(e, info) => {
                const threshold = 100; // deliberate swipe
                if (info.offset.x < -threshold) {
                  handleNext();
                } else if (info.offset.x > threshold) {
                  handlePrev();
                }
              }}
              style={{
                width: '100%',
                maxWidth: '420px',
                aspectRatio: '1/1',
                zIndex: 1,
                cursor: 'grab'
              }}
              whileTap={{ cursor: 'grabbing' }}
            >
              <motion.img 
                layoutId="cover-art-large"
                src={coverUrl || '/default-album.png'} 
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: 'var(--radius-lg)',
                  objectFit: 'cover',
                  boxShadow: isPlaying ? '0 30px 60px rgba(0,0,0,0.6)' : '0 10px 30px rgba(0,0,0,0.3)',
                  transition: 'box-shadow 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  pointerEvents: 'none'
                }}
              />
            </motion.div>
          </div>

          {/* Info & Controls */}
          <div style={{ marginTop: '30px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ fontSize: '26px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h2>
                    <p style={{ fontSize: '17px', color: 'var(--text-secondary)', marginTop: '2px' }}>{artist}</p>
                </div>
            </div>

            {/* ProgressBar with thumb */}
            <ProgressBar />

            {/* Main Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 8px', marginTop: '10px' }}>
              <motion.button 
                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                onClick={toggleShuffle} 
                style={{ 
                    padding: '12px', color: isShuffle ? 'var(--primary)' : 'var(--text-tertiary)', transition: 'color 0.2s',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                }}
              >
                <Shuffle size={26} />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} 
                onClick={handlePrev} 
                style={{ padding: '12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'white' }}
              >
                <SkipBack size={36} fill="white" strokeWidth={0} />
              </motion.button>
              
              <motion.button 
                whileTap={{ scale: 0.92 }}
                whileHover={{ scale: 1.05 }}
                onClick={togglePlay}
                style={{ 
                  background: 'white', color: 'black', 
                  width: '76px', height: '76px', 
                  borderRadius: '38px', 
                  display: 'flex', justifyContent: 'center', alignItems: 'center',
                  boxShadow: '0 10px 20px rgba(255,255,255,0.1)',
                  border: 'none', cursor: 'pointer'
                }}
              >
                {isPlaying ? <Pause size={36} fill="black" strokeWidth={0} /> : <Play size={36} fill="black" strokeWidth={0} style={{ marginLeft: '6px' }}/>}
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }} 
                onClick={handleNext} 
                style={{ padding: '12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'white' }}
              >
                <SkipForward size={36} fill="white" strokeWidth={0} />
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                onClick={toggleRepeat} 
                style={{ 
                    padding: '12px', color: isRepeat > 0 ? 'var(--primary)' : 'var(--text-tertiary)', position: 'relative', transition: 'color 0.2s',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                }}
              >
                <Repeat size={26} />
                {isRepeat === 2 && (
                    <span style={{ 
                        position: 'absolute', top: '8px', right: '8px',
                        fontSize: '9px', fontWeight: 900, background: 'var(--primary)',
                        color: 'var(--bg-base)', borderRadius: '50%', width: '13px', height: '13px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>1</span>
                )}
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

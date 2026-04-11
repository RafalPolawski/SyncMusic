import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useQueueStore } from '../../store/useQueueStore';
import { useCacheStore } from '../../store/useCacheStore';
import { socket } from '../../lib/webtransport';
import ProgressBar from './ProgressBar';

export default function FullPlayer({ isOpen, onClose }) {
  const { 
    title, artist, coverUrl, isPlaying, 
    isShuffle, isRepeat, currentPath, setModes 
  } = usePlayerStore();

  const cachedPaths = useCacheStore(state => state.cachedPaths);

  const togglePlay = () => {
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  const handleNext = () => {
    const next = useQueueStore.getState().nextTrack();
    if (next) {
        socket.sendCommand('load', { song: next.path, folder: next.folder, title: next.title, artist: next.artist });
    } else {
        socket.sendCommand('skip');
    }
  };

  const handlePrev = () => {
      socket.sendCommand('seek', { time: 0 });
  };

  const toggleShuffle = () => {
      const newShuffle = !isShuffle;
      setModes(newShuffle, isRepeat);
      socket.sendCommand('shuffle', { state: newShuffle });
  };

  const toggleRepeat = () => {
      const newRepeat = (isRepeat + 1) % 3;
      setModes(isShuffle, newRepeat);
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
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'var(--bg-base)',
            display: 'flex', flexDirection: 'column',
            padding: 'env(safe-area-inset-top, 20px) 24px 40px 24px'
          }}
        >
          {/* Top Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
            <button onClick={onClose} style={{ padding: '8px' }}>
              <ChevronDown size={32} />
            </button>
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
            <div style={{ width: 48 }} />
          </div>

          {/* Cover Art */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0 }}>
            <motion.img 
              layoutId="cover-art-large"
              src={coverUrl || '/default-album.png'} 
              style={{
                width: '100%',
                maxWidth: '420px',
                aspectRatio: '1/1',
                borderRadius: 'var(--radius-lg)',
                objectFit: 'cover',
                boxShadow: isPlaying ? '0 30px 60px rgba(0,0,0,0.6)' : '0 10px 30px rgba(0,0,0,0.3)',
                transition: 'box-shadow 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            />
          </div>

          {/* Info & Controls */}
          <div style={{ marginTop: '30px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ fontSize: '26px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h2>
                    <p style={{ fontSize: '17px', color: 'var(--text-secondary)', marginTop: '2px' }}>{artist}</p>
                </div>
            </div>

            {/* Performance Optimized ProgressBar */}
            <ProgressBar />

            {/* Main Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 8px', marginTop: '10px' }}>
              <button 
                onClick={toggleShuffle} 
                className={isShuffle ? 'active-icon' : ''}
                style={{ 
                    padding: '12px',
                    color: isShuffle ? 'var(--primary)' : 'var(--text-tertiary)',
                    transition: 'all 0.2s'
                }}
              >
                <Shuffle size={26} />
              </button>
              
              <button onClick={handlePrev} style={{ padding: '12px' }}>
                <SkipBack size={36} fill="white" strokeWidth={0} />
              </button>
              
              <motion.button 
                whileTap={{ scale: 0.92 }}
                onClick={togglePlay}
                style={{ 
                  background: 'white', color: 'black', 
                  width: '76px', height: '76px', 
                  borderRadius: '38px', 
                  display: 'flex', justifyContent: 'center', alignItems: 'center',
                  boxShadow: '0 10px 20px rgba(255,255,255,0.1)'
                }}
              >
                {isPlaying ? <Pause size={36} fill="black" strokeWidth={0} /> : <Play size={36} fill="black" strokeWidth={0} style={{ marginLeft: '6px' }}/>}
              </motion.button>
              
              <button onClick={handleNext} style={{ padding: '12px' }}>
                <SkipForward size={36} fill="white" strokeWidth={0} />
              </button>
              
              <button 
                onClick={toggleRepeat} 
                style={{ 
                    padding: '12px',
                    color: isRepeat > 0 ? 'var(--primary)' : 'var(--text-tertiary)',
                    position: 'relative',
                    transition: 'all 0.2s'
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
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

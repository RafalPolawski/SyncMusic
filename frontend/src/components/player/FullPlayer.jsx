import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function FullPlayer({ isOpen, onClose }) {
  const { 
    title, artist, coverUrl, isPlaying, 
    currentTime, duration, isShuffle, isRepeat,
    setModes
  } = usePlayerStore();

  const togglePlay = () => {
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  const handleNext = () => {
    const { nextTrack } = require('../../store/useQueueStore').useQueueStore.getState();
    const next = nextTrack();
    if (next) {
        socket.sendCommand('load', { song: next.path, folder: next.folder });
    } else {
        socket.sendCommand('skip'); // Let server/host handle if no local queue
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
            <span style={{ fontSize: '13px', fontWeight: 600, letterSpacing: '2px', color: 'var(--text-tertiary)' }}>
              NOW PLAYING
            </span>
            <div style={{ width: 48 }} /> {/* spacer */}
          </div>

          {/* Cover Art */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0 }}>
            <motion.img 
              layoutId="cover-art"
              src={coverUrl || '/default-album.png'} 
              style={{
                width: '100%',
                maxWidth: '400px',
                aspectRatio: '1/1',
                borderRadius: 'var(--radius-lg)',
                objectFit: 'cover',
                boxShadow: isPlaying ? '0 20px 50px rgba(0,0,0,0.5)' : '0 10px 30px rgba(0,0,0,0.3)',
                transition: 'box-shadow 0.3s ease'
              }}
            />
          </div>

          {/* Info & Controls */}
          <div style={{ marginTop: '40px' }}>
            <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>{title}</h2>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>{artist}</p>

            {/* Progress Bar */}
            <div style={{ marginTop: '30px', marginBottom: '20px' }}>
              <div 
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const percent = (e.clientX - rect.left) / rect.width;
                  socket.sendCommand('seek', { time: percent * duration });
                }}
                style={{ 
                  width: '100%', height: '8px', background: 'rgba(255,255,255,0.1)', 
                  borderRadius: '4px', cursor: 'pointer', position: 'relative' 
                }}
              >
                <div style={{ width: `${(currentTime / (duration || 1)) * 100}%`, height: '100%', background: 'var(--primary)', borderRadius: '4px', transition: 'width 0.1s linear' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', fontSize: '13px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
                <span>{Math.floor(currentTime/60)}:{(Math.floor(currentTime%60)).toString().padStart(2,'0')}</span>
                <span>{Math.floor(duration/60)}:{(Math.floor(duration%60)).toString().padStart(2,'0')}</span>
              </div>
            </div>

            {/* Main Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 10px' }}>
              <button 
                onClick={toggleShuffle} 
                style={{ color: isShuffle ? 'var(--primary)' : 'var(--text-tertiary)' }}
              >
                <Shuffle size={24} />
              </button>
              <button onClick={handlePrev}><SkipBack size={32} fill="currentColor" /></button>
              
              <button 
                onClick={togglePlay}
                style={{ 
                  background: 'white', color: 'black', 
                  width: '64px', height: '64px', 
                  borderRadius: '32px', 
                  display: 'flex', justifyContent: 'center', alignItems: 'center' 
                }}
              >
                {isPlaying ? <Pause size={32} fill="black" /> : <Play size={32} fill="black" style={{ marginLeft: '4px' }}/>}
              </button>
              
              <button onClick={handleNext}><SkipForward size={32} fill="currentColor" /></button>
              <button 
                onClick={toggleRepeat} 
                style={{ color: isRepeat ? 'var(--primary)' : 'var(--text-tertiary)' }}
              >
                <Repeat size={24} />
                {isRepeat === 2 && <span style={{ position: 'absolute', fontSize: '10px', fontWeight: 'bold', marginTop: '14px', marginLeft: '-14px', color: 'var(--bg-base)', background: 'var(--primary)', borderRadius: '50%', padding: '1px 3px' }}>1</span>}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

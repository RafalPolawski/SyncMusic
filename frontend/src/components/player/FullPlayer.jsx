import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
    Play, Pause, SkipBack, SkipForward, 
    Shuffle, Repeat, ListMusic, 
    RotateCcw, RotateCw 
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';
import { playNext, playPrev, skipTime, generateSharedShuffle } from '../../lib/playerActions';
import ProgressBar from './ProgressBar';

export default function FullPlayer({ isOpen, onClose, onNavigate }) {
  const title = usePlayerStore(state => state.title);
  const artist = usePlayerStore(state => state.artist);
  const coverUrl = usePlayerStore(state => state.coverUrl);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const isShuffle = usePlayerStore(state => state.isShuffle);
  const isRepeat = usePlayerStore(state => state.isRepeat);
  const setModes = usePlayerStore(state => state.setModes);

  const togglePlay = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(12);
    usePlayerStore.setState({ isPlaying: !isPlaying });
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  const handleNext = () => { if (window.navigator.vibrate) window.navigator.vibrate(10); playNext(); };
  const handlePrev = () => { if (window.navigator.vibrate) window.navigator.vibrate(10); playPrev(); };
  const handleSkip = (delta) => { if (window.navigator.vibrate) window.navigator.vibrate(8); skipTime(delta); };

  const toggleShuffle = () => {
      const newShuffle = !isShuffle;
      const player = usePlayerStore.getState();
      const payload = { state: newShuffle };
      
      if (newShuffle && player.playbackContextFolder) {
          payload.shuffled_sequence = generateSharedShuffle(player.playbackContextFolder, player.currentPath);
      }
      
      socket.sendCommand('shuffle', { ...payload, is_queue: false });
  };

  const toggleRepeat = () => {
      const newRepeat = (isRepeat + 1) % 3;
      setModes(isShuffle, newRepeat);
      usePlayerStore.setState({ isRepeat: newRepeat });
      socket.sendCommand('repeat', { state: newRepeat });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
          transition={{ type: "spring", damping: 35, stiffness: 250, mass: 0.8 }}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          onDragEnd={(e, info) => { if (info.offset.y > 150) onClose(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'var(--bg-base)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden', padding: 'env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0'
          }}
        >
          {/* ADAPTIVE BACKGROUND */}
          <div style={{ position: 'absolute', inset: 0, zIndex: -1, overflow: 'hidden' }}>
             <motion.img 
                key={coverUrl} initial={{ opacity: 0 }} animate={{ opacity: 0.35 }}
                src={coverUrl || '/default-album.png'}
                style={{ position: 'absolute', inset: '-10%', width: '120%', height: '120%', objectFit: 'cover', filter: 'blur(100px) saturate(2)' }}
             />
             <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, var(--bg-base) 85%)' }} />
          </div>

          {/* DISMISS HANDLE AREA */}
          <div 
            onClick={onClose}
            style={{ display: 'flex', justifyContent: 'center', padding: '16px 0 24px 0', cursor: 'pointer', zIndex: 110 }}
          >
            <div style={{ width: '40px', height: '5px', background: 'rgba(255,255,255,0.2)', borderRadius: '10px' }} />
          </div>

          {/* SCROLLABLE / FLEXIBLE CONTENT */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 28px', justifyContent: 'space-between', minHeight: 0 }}>
            
            {/* COMPACT COVER ART with Swipe */}
            <div style={{ flex: '1.2', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0, padding: '10px 0' }}>
               <motion.div
                  layoutId="cover-art-large"
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.6}
                  onDragEnd={(e, info) => {
                    const threshold = 100;
                    if (info.offset.x < -threshold) handleNext();
                    else if (info.offset.x > threshold) handlePrev();
                  }}
                  whileTap={{ cursor: 'grabbing', scale: 0.95 }}
                  style={{
                    width: 'min(80vw, 320px)', height: 'min(80vw, 320px)',
                    borderRadius: '16px', overflow: 'hidden',
                    boxShadow: isPlaying ? '0 25px 50px rgba(0,0,0,0.6)' : '0 10px 20px rgba(0,0,0,0.4)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    cursor: 'grab', touchAction: 'none'
                  }}
               >
                  <img src={coverUrl || '/default-album.png'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
               </motion.div>
            </div>

            {/* TRACK INFO & CONTROLS CONTAINER */}
            <div style={{ flex: '0 0 auto', paddingBottom: '20px' }}>
                <div style={{ marginBottom: '16px' }}>
                    <motion.h2 
                        key={title} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                        style={{ fontSize: '24px', fontWeight: 800, color: 'white', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                        {title || 'Unknown Track'}
                    </motion.h2>
                    <motion.p 
                    key={artist} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}
                    style={{ fontSize: '18px', color: 'white', fontWeight: 600, opacity: 0.8 }}
                >
                    {artist || 'Unknown Artist'}
                </motion.p>
                </div>

                <ProgressBar />

                {/* MAIN CONTROLS PANEL */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 24px 0' }}>
                    <button onClick={handlePrev} style={{ color: 'white' }}><SkipBack size={28} fill="white" strokeWidth={0} /></button>
                    
                    <button onClick={() => handleSkip(-10)} style={{ color: 'rgba(255,255,255,0.7)', position: 'relative' }}>
                        <RotateCcw size={26} />
                        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 800, marginTop: '2px' }}>10</span>
                    </button>
                    
                    <motion.button 
                        whileTap={{ scale: 0.9 }} onClick={togglePlay}
                        style={{ 
                            background: 'var(--dominant-color)', color: 'black', 
                            width: '72px', height: '72px', borderRadius: '50%',
                            boxShadow: '0 8px 24px rgba(var(--dominant-color-rgb), 0.5)',
                        }}
                    >
                        {isPlaying ? <Pause size={32} fill="black" strokeWidth={0} /> : <Play size={32} fill="black" strokeWidth={0} style={{ marginLeft: '4px' }} />}
                    </motion.button>
                    
                    <button onClick={() => handleSkip(10)} style={{ color: 'rgba(255,255,255,0.7)', position: 'relative' }}>
                        <RotateCw size={26} />
                        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 800, marginTop: '2px' }}>10</span>
                    </button>

                    <button onClick={handleNext} style={{ color: 'white' }}><SkipForward size={28} fill="white" strokeWidth={0} /></button>
                </div>
                
                {/* SECONDARY UTILITY BAR */}
                <div style={{ 
                    display: 'flex', justifyContent: 'space-around', alignItems: 'center', 
                    padding: '8px 4px', borderRadius: '16px', background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.04)'
                }}>
                    <button 
                        onClick={toggleShuffle} 
                        style={{ 
                            color: isShuffle ? 'black' : 'rgba(255,255,255,0.5)',
                            background: isShuffle ? 'var(--dominant-color)' : 'transparent',
                            padding: '10px 18px', borderRadius: '12px', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                        }}
                    >
                        <Shuffle size={20} strokeWidth={isShuffle ? 3 : 2} />
                    </button>
                    
                    <button 
                        onClick={() => { onNavigate('queue'); onClose(); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'rgba(255,255,255,0.6)', fontWeight: 800, fontSize: '11px', letterSpacing: '0.05em' }}
                    >
                       <ListMusic size={20} />
                       HISTORY
                    </button>

                    <button 
                        onClick={toggleRepeat} 
                        style={{ 
                            color: isRepeat > 0 ? 'black' : 'rgba(255,255,255,0.5)',
                            background: isRepeat > 0 ? 'var(--dominant-color)' : 'transparent',
                            padding: '10px 18px', borderRadius: '12px', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            position: 'relative'
                        }}
                    >
                        <Repeat size={20} strokeWidth={isRepeat > 0 ? 3 : 2} />
                        {isRepeat === 2 && <span style={{ position: 'absolute', top: '4px', right: '8px', fontSize: '8px', fontWeight: 900 }}>1</span>}
                    </button>
                </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

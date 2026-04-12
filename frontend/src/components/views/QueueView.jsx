import React, { useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueueStore } from '../../store/useQueueStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { getUpcomingTracks } from '../../lib/playerActions';
import { socket } from '../../lib/webtransport';
import { Trash2, GripVertical, Sparkles, Hash } from 'lucide-react';

// Simplified Item Component for Performance
const UpcomingItem = React.memo(({ song, index }) => (
    <div
      className="glass-panel"
      style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 14px 10px 8px',
        background: 'rgba(255,255,255,0.02)',
        borderRadius: 'var(--radius-sm)',
        borderColor: 'rgba(255,255,255,0.06)',
        opacity: 0.6,
      }}
    >
      <div style={{ width: 14 }} />
      <img 
        src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
        style={{ width: '40px', height: '40px', borderRadius: '10px', marginRight: '14px', objectFit: 'cover' }} 
        alt="" 
        loading="lazy"
        onError={(e) => { e.currentTarget.src = '/default-album.png'; }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="text-ellipsis" style={{ fontWeight: 700, fontSize: '14px' }}>{song.title}</div>
        <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{song.artist}</div>
      </div>
    </div>
));

export default function QueueView() {
  const queue = useQueueStore(state => state.queue);
  const currentPath = usePlayerStore(state => state.currentPath);
  const title = usePlayerStore(state => state.title);
  const artist = usePlayerStore(state => state.artist);
  const coverUrl = usePlayerStore(state => state.coverUrl);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const isShuffle = usePlayerStore(state => state.isShuffle);
  const isRepeat = usePlayerStore(state => state.isRepeat);
  const playbackContextFolder = usePlayerStore(state => state.playbackContextFolder);
  const shuffledQueue = usePlayerStore(state => state.shuffledQueue);
  const { groups } = useLibraryStore();
  
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const dragItemRef = useRef(null);

  // Accurate prediction list (increased limit to support large libraries)
  const upcomingTracksFull = useMemo(() => {
    const allUpcoming = getUpcomingTracks(1000);
    const queuePaths = new Set(queue.map(q => q.path));
    return allUpcoming.filter(t => !queuePaths.has(t.path));
  }, [queue, currentPath, isShuffle, isRepeat, groups, playbackContextFolder, shuffledQueue]);

  const totalRemaining = queue.length + upcomingTracksFull.length;

  // Performance optimization: only render first 40 items in DOM
  const visibleUpcoming = upcomingTracksFull.slice(0, 40);

  const handleDragStart = useCallback((e, idx) => {
    if (window.navigator.vibrate) window.navigator.vibrate(5);
    setDraggingIdx(idx);
    dragItemRef.current = idx;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, idx) => {
    e.preventDefault();
    if (dragItemRef.current === null || dragItemRef.current === idx) return;
    setOverIdx(idx);
  }, []);

  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const fromIdx = dragItemRef.current;
    if (fromIdx === null || fromIdx === undefined || fromIdx === dropIdx) {
        setDraggingIdx(null); setOverIdx(null); return;
    }
    const next = [...queue];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(dropIdx, 0, moved);
    useQueueStore.getState().setQueue(next);
    socket.sendCommand('queue_move', { from: fromIdx, to: dropIdx });
    setDraggingIdx(null); setOverIdx(null); dragItemRef.current = null;
  }, [queue]);

  const handleDequeue = useCallback((index) => {
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    const item = queue[index];
    socket.sendCommand('dequeue', { id: item.id || null, index });
    const next = [...queue];
    next.splice(index, 1);
    useQueueStore.getState().setQueue(next);
  }, [queue]);

  return (
    <div style={{ padding: '24px', paddingBottom: '160px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
          <h1 style={{ fontSize: '32px', fontWeight: 800 }}>History</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', background: 'var(--bg-surface)', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.05)' }}>
             <Hash size={14} color="var(--primary)" />
             <span style={{ fontSize: '13px', fontWeight: 900, letterSpacing: '0.05em' }}>{totalRemaining} REMAINING</span>
          </div>
      </div>
      
      {/* Now Playing */}
      {currentPath && (
        <div style={{ marginBottom: '40px' }}>
          <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.15em', fontWeight: 800 }}>
            NOW PLAYING
          </h2>
          <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', padding: '16px', background: 'var(--primary-glass)', borderRadius: 'var(--radius-md)', borderColor: 'var(--primary)' }}>
            <img src={coverUrl || '/default-album.png'} style={{ width: '60px', height: '60px', borderRadius: '14px', marginRight: '16px', objectFit: 'cover' }} alt="" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-ellipsis" style={{ fontWeight: 800, fontSize: '17px' }}>{title}</div>
              <div className="text-ellipsis" style={{ fontSize: '13px', color: 'var(--primary)', marginTop: '4px', fontWeight: 600 }}>{artist}</div>
            </div>
          </div>
        </div>
      )}

      {/* Manual Queue (Animated layout as it's small usually) */}
      {queue.length > 0 && (
        <div style={{ marginBottom: '32px' }}>
          <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '16px', letterSpacing: '0.15em', fontWeight: 800 }}>
            USER QUEUE ({queue.length})
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {queue.map((song, idx) => (
              <motion.div
                key={`q-${song.path}-${idx}`}
                layout
                draggable
                onDragStart={(e) => handleDragStart(e, idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={(e) => handleDrop(e, idx)}
                onDragEnd={() => { setDraggingIdx(null); setOverIdx(null); }}
                className="glass-panel"
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '10px 14px 10px 8px',
                  background: draggingIdx === idx ? 'var(--primary-glass)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 'var(--radius-sm)',
                  borderColor: overIdx === idx ? 'var(--primary)' : 'rgba(255,255,255,0.06)',
                  cursor: 'grab',
                }}
              >
                <div style={{ color: 'var(--text-tertiary)', padding: '0 12px 0 4px' }}>
                  <GripVertical size={18} />
                </div>
                <img 
                  src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                  style={{ width: '44px', height: '44px', borderRadius: '10px', marginRight: '14px', objectFit: 'cover' }} 
                  alt="" 
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 700, fontSize: '15px' }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{song.artist}</div>
                </div>
                <button onClick={() => handleDequeue(idx)} style={{ padding: '10px', color: 'var(--text-tertiary)' }}>
                  <Trash2 size={18} />
                </button>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming / Prediction (Static rendering for performance) */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>
                UPCOMING
            </h2>
            <Sparkles size={12} color="var(--primary)" />
        </div>
        
        {upcomingTracksFull.length === 0 ? (
          <div style={{ opacity: 0.4, fontSize: '14px', textAlign: 'center', padding: '20px' }}>No more tracks in sequence</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {visibleUpcoming.map((song, idx) => (
              <UpcomingItem key={`u-${song.path}-${idx}`} song={song} index={idx} />
            ))}
            {upcomingTracksFull.length > 40 && (
                <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: 600 }}>
                    ... and {upcomingTracksFull.length - 40} more tracks
                </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

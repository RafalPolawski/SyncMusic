import React, { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueueStore } from '../../store/useQueueStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';
import { Trash2, AudioLines, GripVertical, ListMusicIcon } from 'lucide-react';

export default function QueueView() {
  const queue = useQueueStore(state => state.queue);
  const setQueue = useQueueStore(state => state.setQueue);
  const { currentPath, title, artist, coverUrl, isPlaying } = usePlayerStore();
  
  // Manual drag state (more reliable on mobile than Reorder.Group)
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const dragItemRef = useRef(null);

  const handleDragStart = useCallback((e, idx) => {
    setDraggingIdx(idx);
    dragItemRef.current = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', idx);
    }
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
      setDraggingIdx(null);
      setOverIdx(null);
      return;
    }

    // Use latest queue state to avoid closure issues
    const currentQueue = useQueueStore.getState().queue;
    if (!currentQueue[fromIdx]) return;

    const next = [...currentQueue];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(dropIdx, 0, moved);
    
    // Update local store immediately for zero-lag UI
    setQueue(next);
    
    // Notify server
    socket.sendCommand('queue_move', { 
        from: Number(fromIdx), 
        to: Number(dropIdx) 
    });

    setDraggingIdx(null);
    setOverIdx(null);
    dragItemRef.current = null;
  }, [setQueue]);

  const handleDragEnd = useCallback(() => {
    setDraggingIdx(null);
    setOverIdx(null);
    dragItemRef.current = null;
  }, []);

  const handleDequeue = useCallback((index) => {
    const item = queue[index];
    if (item?.id) {
      socket.sendCommand('dequeue', { id: item.id });
    } else {
      socket.sendCommand('dequeue', { index });
    }
    const next = [...queue];
    next.splice(index, 1);
    setQueue(next);
  }, [queue, setQueue]);

  return (
    <div style={{ padding: '20px', paddingBottom: '160px' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '24px' }}>Queue</h1>
      
      {/* Currently Playing */}
      {currentPath && (
        <div style={{ marginBottom: '28px' }}>
          <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '10px', letterSpacing: '1.5px', fontWeight: 700 }}>
            Now Playing
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px', background: 'rgba(29, 185, 84, 0.08)', borderRadius: '14px', border: '1px solid var(--primary)' }}>
            <img src={coverUrl || '/default-album.png'} style={{ width: '54px', height: '54px', borderRadius: '10px', marginRight: '14px', objectFit: 'cover', flexShrink: 0 }} alt="" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-ellipsis" style={{ fontWeight: 700, fontSize: '16px', color: 'white' }}>{title}</div>
              <div className="text-ellipsis" style={{ fontSize: '13px', color: 'var(--primary)', marginTop: '3px' }}>{artist}</div>
            </div>
            {/* EQ animation */}
            <div style={{ display: 'flex', gap: '3px', height: '20px', alignItems: 'flex-end', marginLeft: '12px', flexShrink: 0 }}>
              {[1, 2, 3].map(i => (
                <motion.div
                  key={i}
                  animate={isPlaying ? { height: ['4px', '20px', '8px', '16px', '4px'] } : { height: '4px' }}
                  transition={{ repeat: Infinity, duration: 0.7 + i * 0.15, ease: 'easeInOut' }}
                  style={{ width: '3px', background: 'var(--primary)', borderRadius: '2px' }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Up Next */}
      {queue.length > 0 && (
        <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '1.5px', fontWeight: 700 }}>
          Up Next ({queue.length})
        </h2>
      )}
      
      {queue.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', marginTop: '60px', padding: '0 20px' }}>
          <ListMusicIcon size={44} style={{ margin: '0 auto 14px', opacity: 0.25, display: 'block' }} />
          <div style={{ fontSize: '17px', fontWeight: 600 }}>Queue is empty</div>
          <div style={{ fontSize: '13px', marginTop: '8px', opacity: 0.6, lineHeight: 1.5 }}>Tap the + button next to any track to add it</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {queue.map((song, index) => {
            const isDragging = draggingIdx === index;
            const isOver = overIdx === index;
            // Use ID if available, otherwise path+original index to keep key stable during the life of a drag
            const rowKey = song.id || `q-${song.path}-${index}`;
            
            return (
              <div
                key={rowKey}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '12px 12px 12px 8px',
                  background: isDragging ? 'rgba(29, 185, 84, 0.1)' : 'rgba(255,255,255,0.03)',
                  borderRadius: '12px',
                  border: isOver ? '1px dashed var(--primary)' : isDragging ? '1px solid var(--primary)' : '1px solid rgba(255,255,255,0.05)',
                  opacity: isDragging ? 0.6 : 1,
                  transition: 'background 0.15s, border 0.15s, opacity 0.15s',
                  cursor: 'grab',
                  touchAction: 'manipulation',
                  userSelect: 'none',
                }}
              >
                {/* Drag handle visual */}
                <div style={{ color: 'var(--text-tertiary)', padding: '0 10px 0 2px', flexShrink: 0 }}>
                  <GripVertical size={18} />
                </div>

                <img 
                  src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                  style={{ width: '46px', height: '46px', borderRadius: '8px', marginRight: '12px', objectFit: 'cover', flexShrink: 0, pointerEvents: 'none' }} 
                  alt="" 
                  onError={(e) => { e.currentTarget.src = '/default-album.png'; }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 500, fontSize: '14px' }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{song.artist}</div>
                </div>
                <motion.button 
                  onClick={(e) => { e.stopPropagation(); handleDequeue(index); }}
                  whileHover={{ scale: 1.2, color: '#ff6b6b' }}
                  whileTap={{ scale: 0.9 }}
                  style={{ padding: '10px', color: 'var(--text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                >
                  <Trash2 size={17} />
                </motion.button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

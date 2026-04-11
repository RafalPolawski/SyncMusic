import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueueStore } from '../../store/useQueueStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { Trash2, AudioLines } from 'lucide-react';

export default function QueueView() {
  const { queue, dequeue } = useQueueStore();
  const { currentPath, title, artist, coverUrl } = usePlayerStore();

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '24px' }}>Queue</h1>
      
      {/* Currently Playing Header */}
      {currentPath && (
        <div style={{ marginBottom: '32px' }}>
          <h2 style={{ fontSize: '14px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '1px' }}>
            Now Playing
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px', background: 'var(--bg-surface-elevated)', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
            <img src={coverUrl} style={{ width: '56px', height: '56px', borderRadius: '8px', marginRight: '16px', objectFit: 'cover' }} alt="" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="text-ellipsis" style={{ fontWeight: 600, fontSize: '16px', color: 'var(--primary)' }}>{title}</div>
              <div className="text-ellipsis" style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '2px' }}>{artist}</div>
            </div>
            <AudioLines size={24} color="var(--primary)" />
          </div>
        </div>
      )}

      {/* Up Next List */}
      <h2 style={{ fontSize: '14px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '16px', letterSpacing: '1px' }}>
        Up Next
      </h2>
      
      {queue.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', marginTop: '40px' }}>
          Queue is empty.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <AnimatePresence>
            {queue.map((song, index) => (
              <motion.div 
                key={`${song.path}-${index}`}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                style={{
                  display: 'flex', alignItems: 'center', padding: '12px',
                  background: 'rgba(255,255,255,0.02)', borderRadius: '12px',
                }}
              >
                <img 
                  src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                  style={{ width: '48px', height: '48px', borderRadius: '8px', marginRight: '16px', objectFit: 'cover' }} 
                  alt="" 
                  onError={(e) => { e.currentTarget.src = '/default-album.png'; }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 500, fontSize: '15px' }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{song.artist}</div>
                </div>
                <button onClick={() => dequeue(index)} style={{ padding: '8px', color: 'var(--text-tertiary)' }}>
                  <Trash2 size={20} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

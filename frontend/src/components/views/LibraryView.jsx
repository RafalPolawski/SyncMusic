import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useQueueStore } from '../../store/useQueueStore';
import { socket } from '../../lib/webtransport';
import { Folder, Play, Plus, ChevronLeft } from 'lucide-react';

export default function LibraryView() {
  const { groups, isLoading, isScanning, fetchLibrary } = useLibraryStore();
  const { enqueue } = useQueueStore();
  const [selectedFolder, setSelectedFolder] = useState(null);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  const handlePlaySong = (song, folder) => {
    socket.sendCommand('load', { song: song.path, folder, title: song.title, artist: song.artist });
  };

  const handleEnqueue = (e, song, folder) => {
    e.stopPropagation();
    enqueue({ ...song, folder });
  };

  if (isLoading || isScanning) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
          <Folder size={48} opacity={0.5} />
        </motion.div>
        <p style={{ marginTop: '16px' }}>{isScanning ? 'Scanning...' : 'Loading library...'}</p>
      </div>
    );
  }

  const renderFolders = () => (
    <motion.div 
      initial={{ opacity: 0, x: -20 }} 
      animate={{ opacity: 1, x: 0 }} 
      exit={{ opacity: 0, x: -20 }}
      style={{ padding: '20px' }}
    >
      <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '24px' }}>Library</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '16px' }}>
        {Object.keys(groups).map((folder) => (
          <motion.div
            key={folder}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setSelectedFolder(folder)}
            style={{
              background: 'var(--bg-surface)', padding: '20px',
              borderRadius: '16px', display: 'flex', flexDirection: 'column', 
              alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)',
              cursor: 'pointer', textAlign: 'center'
            }}
          >
            <Folder size={40} color="var(--primary)" style={{ marginBottom: '12px' }} />
            <div className="text-ellipsis" style={{ width: '100%', fontWeight: 600, fontSize: '14px' }}>
              {folder}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
              {groups[folder].length} tracks
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );

  const renderSongs = () => {
    const songs = groups[selectedFolder] || [];
    return (
      <motion.div 
        key="songs"
        initial={{ opacity: 0, x: 20 }} 
        animate={{ opacity: 1, x: 0 }} 
        exit={{ opacity: 0, x: 20 }}
        style={{ padding: '20px' }}
      >
        <button 
          onClick={() => setSelectedFolder(null)}
          style={{ display: 'flex', alignItems: 'center', color: 'var(--primary)', marginBottom: '20px', fontWeight: 600 }}
        >
          <ChevronLeft size={20} style={{ marginRight: '4px' }} /> Back to Library
        </button>
        
        <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '20px' }}>{selectedFolder}</h2>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {songs.map(song => (
            <motion.div 
              key={song.path}
              whileHover={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handlePlaySong(song, selectedFolder)}
              style={{
                display: 'flex', alignItems: 'center', padding: '12px',
                background: 'rgba(255,255,255,0.02)', borderRadius: '12px',
                cursor: 'pointer', border: '1px solid transparent'
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
              <button onClick={(e) => handleEnqueue(e, song, selectedFolder)} style={{ padding: '8px', marginRight: '8px', color: 'var(--text-tertiary)', background: 'rgba(255,255,255,0.05)', borderRadius: '50%' }}>
                <Plus size={20} />
              </button>
              <Play size={20} color="var(--primary)" />
            </motion.div>
          ))}
        </div>
      </motion.div>
    );
  };

  return (
    <AnimatePresence mode="wait">
      {selectedFolder ? renderSongs() : renderFolders()}
    </AnimatePresence>
  );
}

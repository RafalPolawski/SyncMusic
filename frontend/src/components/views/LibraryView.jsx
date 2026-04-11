import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useQueueStore } from '../../store/useQueueStore';
import { useCacheStore } from '../../store/useCacheStore';
import { socket } from '../../lib/webtransport';
import { Folder, Play, Plus, ChevronLeft, Download, CheckCircle2, Loader2 } from 'lucide-react';

export default function LibraryView() {
  const { groups, isLoading, isScanning, fetchLibrary } = useLibraryStore();
  const { enqueue } = useQueueStore();
  const { cacheSongs, cachedPaths, activeJobs, initCacheListener } = useCacheStore();
  const [selectedFolder, setSelectedFolder] = useState(null);

  useEffect(() => {
    fetchLibrary();
    initCacheListener();
  }, [fetchLibrary, initCacheListener]);

  const handlePlaySong = (song, folder) => {
    socket.sendCommand('load', { song: song.path, folder, title: song.title, artist: song.artist });
  };

  const handleEnqueue = (e, song, folder) => {
    e.stopPropagation();
    enqueue({ ...song, folder });
  };

  const handleCacheFolder = (e, folderName) => {
    e.stopPropagation();
    const songs = groups[folderName] || [];
    cacheSongs(songs, folderName);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 800 }}>Library</h1>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px' }}>
        {Object.keys(groups).map((folder) => {
          const job = activeJobs.get(folder);
          const tracksInFolder = groups[folder] || [];
          const cachedInFolder = tracksInFolder.filter(s => cachedPaths.has(s.path)).length;
          const isFullyCached = tracksInFolder.length > 0 && cachedInFolder === tracksInFolder.length;
          const progress = job ? Math.round((job.processed / job.total) * 100) : 0;

          return (
            <motion.div
              key={folder}
              whileHover={{ scale: 1.02, backgroundColor: 'rgba(255,255,255,0.05)' }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setSelectedFolder(folder)}
              style={{
                background: 'var(--bg-surface)', padding: '16px',
                borderRadius: '16px', display: 'flex', flexDirection: 'column', 
                alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)',
                cursor: 'pointer', textAlign: 'center', position: 'relative'
              }}
            >
              <div style={{ position: 'absolute', top: '8px', right: '8px' }}>
                {isFullyCached ? (
                  <CheckCircle2 size={16} color="var(--primary)" />
                ) : job ? (
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
                    <Loader2 size={16} color="var(--primary)" />
                  </motion.div>
                ) : (
                  <button 
                    onClick={(e) => handleCacheFolder(e, folder)}
                    style={{ color: 'var(--text-tertiary)', padding: '4px', borderRadius: '50%', background: 'rgba(255,255,255,0.03)' }}
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>

              <Folder size={44} color={isFullyCached ? 'var(--primary)' : 'var(--text-tertiary)'} style={{ marginBottom: '12px' }} />
              <div className="text-ellipsis" style={{ width: '100%', fontWeight: 600, fontSize: '14px' }}>
                {folder}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                {cachedInFolder} / {tracksInFolder.length} offline
              </div>

              {/* Progress Line */}
              {job && (
                <div style={{ width: '100%', height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '10px', overflow: 'hidden' }}>
                    <div style={{ width: `${progress}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s' }} />
                </div>
              )}
            </motion.div>
          );
        })}
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
        style={{ padding: '20px', paddingBottom: '100px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <button 
                onClick={() => setSelectedFolder(null)}
                style={{ display: 'flex', alignItems: 'center', color: 'var(--primary)', fontWeight: 600 }}
            >
                <ChevronLeft size={20} style={{ marginRight: '4px' }} /> Back
            </button>
            <button 
                onClick={(e) => handleCacheFolder(e, selectedFolder)}
                style={{ fontSize: '12px', background: 'rgba(255,255,255,0.05)', padding: '6px 12px', borderRadius: '20px', color: 'var(--text-secondary)' }}
            >
                Cache All
            </button>
        </div>
        
        <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '20px' }}>{selectedFolder}</h2>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {songs.map(song => {
            const isCached = cachedPaths.has(song.path);
            return (
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
                <div style={{ position: 'relative', marginRight: '16px' }}>
                    <img 
                    src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                    style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover' }} 
                    alt="" 
                    onError={(e) => { e.currentTarget.src = '/default-album.png'; }}
                    />
                    {isCached && (
                        <div style={{ 
                            position: 'absolute', bottom: '-4px', right: '-4px', 
                            background: 'var(--primary)', borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '16px', height: '16px', border: '2px solid var(--bg-base)'
                        }}>
                            <CheckCircle2 size={10} color="var(--bg-base)" strokeWidth={3} />
                        </div>
                    )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 500, fontSize: '15px', color: isCached ? 'white' : 'var(--text-secondary)' }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{song.artist}</div>
                </div>
                <button onClick={(e) => handleEnqueue(e, song, selectedFolder)} style={{ padding: '8px', marginRight: '8px', color: 'var(--text-tertiary)' }}>
                  <Plus size={20} />
                </button>
                <Play size={20} color="var(--primary)" />
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    );
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
        <AnimatePresence mode="wait">
        {selectedFolder ? renderSongs() : renderFolders()}
        </AnimatePresence>
    </div>
  );
}

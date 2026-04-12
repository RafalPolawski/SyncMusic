import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useQueueStore } from '../../store/useQueueStore';
import { useCacheStore } from '../../store/useCacheStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';
import { Folder, Play, Plus, ChevronLeft, Download, CheckCircle2, Loader2 } from 'lucide-react';

export default function LibraryView({ selectedFolder, onOpenFolder, onCloseFolder }) {
  const { groups, isLoading, isScanning, fetchLibrary } = useLibraryStore();
  const { enqueue } = useQueueStore();
  const { cacheSongs, cachedPaths, activeJobs, initCacheListener } = useCacheStore();
  const { currentPath, currentFolder: activePlayerFolder, isPlaying } = usePlayerStore();
  const [enqueuedFeedback, setEnqueuedFeedback] = useState(new Set());

  useEffect(() => {
    fetchLibrary();
    initCacheListener();
  }, [fetchLibrary, initCacheListener]);

  const handlePlaySong = (song, folder) => {
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    usePlayerStore.setState({ shuffledQueue: [] });
    socket.sendCommand('load', { song: song.path, folder, title: song.title, artist: song.artist });
  };

  const handleEnqueue = (e, song, folder) => {
    e.stopPropagation();
    if (window.navigator.vibrate) window.navigator.vibrate(8);
    enqueue({ ...song, folder });
    
    setEnqueuedFeedback(prev => new Set(prev).add(song.path));
    setTimeout(() => {
        setEnqueuedFeedback(prev => {
            const next = new Set(prev);
            next.delete(song.path);
            return next;
        });
    }, 1200);
  };

  const handleCacheFolder = (e, folderName) => {
    e.stopPropagation();
    if (window.confirm(`Download '${folderName}' for offline use?`)) {
        const songs = groups[folderName] || [];
        cacheSongs(songs, folderName);
    }
  };

  if (isLoading || isScanning) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}>
          <Loader2 size={48} opacity={0.3} />
        </motion.div>
        <p style={{ marginTop: '20px', fontWeight: 600, letterSpacing: '0.05em' }}>{isScanning ? 'SCANNIG...' : 'LOADING...'}</p>
      </div>
    );
  }

  const renderFolders = () => (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      style={{ padding: '24px' }}
    >
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '32px', fontWeight: 800 }}>Library</h1>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '16px' }}>
        {Object.keys(groups).map((folder) => {
          const job = activeJobs.get(folder);
          const tracksInFolder = groups[folder] || [];
          const cachedInFolder = tracksInFolder.filter(s => cachedPaths.has(s.path)).length;
          const isFullyCached = tracksInFolder.length > 0 && cachedInFolder === tracksInFolder.length;
          const progress = job ? Math.round((job.processed / job.total) * 100) : 0;
          
          const isCurrentlyPlaying = activePlayerFolder === folder;

          return (
            <motion.div
              key={folder}
              whileTap={{ scale: 0.96 }}
              onClick={() => onOpenFolder(folder)}
              className="glass-panel"
              style={{
                padding: '20px',
                borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', 
                alignItems: 'center', 
                background: isCurrentlyPlaying ? 'var(--primary-glass)' : 'var(--bg-surface)',
                borderColor: isCurrentlyPlaying ? 'var(--primary)' : 'rgba(255,255,255,0.06)',
                cursor: 'pointer', textAlign: 'center', position: 'relative'
              }}
            >
              <div style={{ position: 'absolute', top: '10px', right: '10px' }}>
                {isFullyCached ? (
                  <CheckCircle2 size={16} color="var(--primary)" />
                ) : job ? (
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
                    <Loader2 size={16} color="var(--primary)" />
                  </motion.div>
                ) : (
                  <button 
                    onClick={(e) => handleCacheFolder(e, folder)}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <Download size={15} />
                  </button>
                )}
              </div>

              <Folder size={48} color={isCurrentlyPlaying ? 'var(--primary)' : isFullyCached ? 'var(--primary)' : 'var(--text-tertiary)'} style={{ marginBottom: '14px', opacity: isCurrentlyPlaying || isFullyCached ? 1 : 0.6 }} />
              <div className="text-ellipsis" style={{ width: '100%', fontWeight: 700, fontSize: '15px', color: isCurrentlyPlaying ? 'var(--primary)' : 'white' }}>
                {folder}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px', fontWeight: 600 }}>
                {tracksInFolder.length} tracks
              </div>

              {job && (
                <div style={{ width: '100%', height: '3px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', marginTop: '12px', overflow: 'hidden' }}>
                    <motion.div animate={{ width: `${progress}%` }} style={{ height: '100%', background: 'var(--primary)' }} />
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
        initial={{ opacity: 0, x: 20 }} 
        animate={{ opacity: 1, x: 0 }} 
        style={{ padding: '24px', paddingBottom: '120px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <button 
                onClick={onCloseFolder}
                style={{ padding: '8px 12px 8px 4px', borderRadius: '100px', background: 'var(--bg-surface)', fontWeight: 700, fontSize: '14px' }}
            >
                <ChevronLeft size={20} style={{ marginRight: '4px' }} /> Back
            </button>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 800, letterSpacing: '0.1em' }}>
                {songs.length} TRACKS
            </div>
        </div>
        
        <h2 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '24px' }}>{selectedFolder}</h2>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {songs.map(song => {
            const isCached = cachedPaths.has(song.path);
            const isPlayingNow = currentPath === song.path;
            
            return (
              <motion.div 
                key={song.path}
                whileTap={{ scale: 0.98 }}
                onClick={() => handlePlaySong(song, selectedFolder)}
                className="glass-panel"
                style={{
                  display: 'flex', alignItems: 'center', padding: '12px',
                  background: isPlayingNow ? 'var(--primary-glass)' : 'rgba(255,255,255,0.02)', 
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer', 
                  borderColor: isPlayingNow ? 'var(--primary)' : 'rgba(255,255,255,0.06)'
                }}
              >
                <div style={{ position: 'relative', marginRight: '16px' }}>
                    <img 
                      src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                      style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', background: 'rgba(0,0,0,0.2)' }} 
                      alt="" 
                      onError={(e) => { e.currentTarget.src = '/default-album.png'; }}
                    />
                    {isCached && (
                        <div style={{ 
                            position: 'absolute', bottom: '-4px', right: '-4px', 
                            background: 'var(--primary)', borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: '18px', height: '18px', border: '3px solid var(--bg-base)'
                        }}>
                            <CheckCircle2 size={10} color="black" strokeWidth={4} />
                        </div>
                    )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 700, fontSize: '16px', color: isPlayingNow ? 'var(--primary)' : 'white' }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '13px', color: isPlayingNow ? 'white' : 'var(--text-secondary)', marginTop: '2px', fontWeight: 500 }}>{song.artist}</div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <motion.button 
                    onClick={(e) => handleEnqueue(e, song, selectedFolder)} 
                    style={{ 
                        width: '40px', height: '40px',
                        color: enqueuedFeedback.has(song.path) ? 'black' : 'var(--primary)', 
                        background: enqueuedFeedback.has(song.path) ? 'var(--primary)' : 'var(--primary-glass)',
                        borderRadius: '12px',
                    }}
                    >
                    {enqueuedFeedback.has(song.path) ? <CheckCircle2 size={20} /> : <Plus size={20} />}
                    </motion.button>

                    {isPlayingNow && (
                    <div style={{ display: 'flex', gap: '3px', height: '16px', alignItems: 'flex-end', padding: '0 8px' }}>
                        {[1, 2, 3].map(i => (
                            <motion.div 
                                key={i}
                                animate={isPlaying ? { height: ['4px', '16px', '6px', '12px', '4px'] } : { height: '4px' }}
                                transition={{ repeat: Infinity, duration: 0.7 + i * 0.15, ease: 'easeInOut' }}
                                style={{ width: '3px', background: 'var(--primary)', borderRadius: '10px' }}
                            />
                        ))}
                    </div>
                    )}
                </div>
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    );
  };

  return (
    <div style={{ paddingBottom: '160px' }}>
        <AnimatePresence mode="wait">
        {selectedFolder ? renderSongs() : renderFolders()}
        </AnimatePresence>
    </div>
  );
}

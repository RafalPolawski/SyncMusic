import React, { useEffect } from 'react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { socket } from '../../lib/webtransport';
import { Play } from 'lucide-react';

export default function LibraryView() {
  const { groups, isLoading, isScanning, fetchLibrary } = useLibraryStore();

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  if (isLoading || isScanning) {
    return <div style={{ padding: '20px', textAlign: 'center' }}>Loading or scanning library...</div>;
  }

  const handlePlaySong = (song, folder) => {
    socket.sendCommand('load', { song: song.path, folder });
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '20px' }}>Library</h1>
      
      {Object.entries(groups).map(([folder, songs]) => (
        <div key={folder} style={{ marginBottom: '30px' }}>
          <h2 style={{ fontSize: '20px', color: 'var(--primary)', marginBottom: '10px' }}>📁 {folder}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {songs.map(song => (
              <div 
                key={song.path}
                onClick={() => handlePlaySong(song, folder)}
                style={{
                  display: 'flex', alignItems: 'center', padding: '10px',
                  background: 'rgba(255,255,255,0.02)', borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                <img 
                  src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                  style={{ width: '40px', height: '40px', borderRadius: '4px', marginRight: '12px' }} 
                  alt="" 
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-ellipsis" style={{ fontWeight: 500 }}>{song.title}</div>
                  <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{song.artist}</div>
                </div>
                <Play size={20} color="var(--text-tertiary)" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

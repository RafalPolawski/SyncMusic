import React from 'react';
import { Play, Pause } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function MiniPlayer({ onClick }) {
  const { title, artist, coverUrl, isPlaying } = usePlayerStore();

  const handlePlayPause = (e) => {
    e.stopPropagation();
    socket.sendCommand(isPlaying ? 'pause' : 'play', { time: usePlayerStore.getState().currentTime });
  };

  return (
    <div 
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        background: 'rgba(20, 20, 25, 0.95)',
        backdropFilter: 'var(--glass-blur)',
        margin: '8px',
        padding: '8px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.05)',
        cursor: 'pointer'
      }}
    >
      <img 
        src={coverUrl || '/default-album.png'} 
        alt="Cover" 
        style={{ width: '40px', height: '40px', borderRadius: '6px', objectFit: 'cover' }}
        onError={(e) => { e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23333"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/%3E%3C/svg%3E'; }}
      />
      
      <div style={{ flex: 1, margin: '0 12px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div className="text-ellipsis" style={{ fontWeight: 600, fontSize: '14px', color: 'white' }}>
          {title}
        </div>
        <div className="text-ellipsis" style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
          {artist}
        </div>
      </div>

      <button 
        onClick={handlePlayPause}
        style={{ 
          padding: '8px', 
          marginRight: '4px',
          color: 'var(--text-primary)' 
        }}
      >
        {isPlaying ? <Pause fill="white" /> : <Play fill="white" />}
      </button>
    </div>
  );
}

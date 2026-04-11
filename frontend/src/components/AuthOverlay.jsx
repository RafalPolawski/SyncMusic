import React, { useState, useEffect } from 'react';
import { useNetworkStore } from '../store/useNetworkStore';
import { useAuthStore } from '../store/useAuthStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { socket } from '../lib/webtransport';

export default function AuthOverlay() {
  const [nickname, setNickname] = useState(localStorage.getItem('syncMusicNick') || '');
  const [roomId, setRoomId] = useState(localStorage.getItem('syncMusicRoom') || 'global');
  
  const { rooms, isLoadingRooms, fetchRooms } = useNetworkStore();
  const { setOffline, setRoom } = usePlayerStore();
  const { setGuestMode, login } = useAuthStore();

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  const handleJoin = () => {
    const nick = nickname.trim() || 'Anonymous';
    setGuestMode(nick);
    setRoom(roomId);
    socket.sendCommand('join', { nickname: nick, room_id: roomId });
  };

  const handleOffline = () => {
    setOffline(true);
    setGuestMode('Offline');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15,12,41,0.95)',
      backdropFilter: 'blur(20px)',
      display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'center',
      padding: '20px'
    }}>
      <h1 style={{ color: 'white', fontSize: '32px', fontWeight: 800, marginBottom: '40px' }}>
        SyncMusic
      </h1>

      <div style={{ background: 'var(--bg-surface)', padding: '30px', borderRadius: '16px', width: '100%', maxWidth: '360px' }}>
        <input 
          type="text" 
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          placeholder="Display Name"
          style={{
            width: '100%', padding: '14px', borderRadius: '12px',
            background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
            color: 'white', fontSize: '16px', marginBottom: '16px',
            outline: 'none'
          }}
        />

        <input 
          type="text" 
          value={roomId}
          onChange={e => setRoomId(e.target.value)}
          placeholder="Room ID"
          style={{
            width: '100%', padding: '14px', borderRadius: '12px',
            background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
            color: 'white', fontSize: '16px', marginBottom: '24px',
            outline: 'none'
          }}
        />

        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>Active Rooms:</div>
          {isLoadingRooms ? (
            <div style={{ color: 'var(--primary)', fontSize: '12px' }}>Loading...</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {rooms.length > 0 ? rooms.map(r => (
                <button key={r} onClick={() => setRoomId(r)} style={{ padding: '6px 12px', background: 'rgba(29, 185, 84, 0.2)', border: '1px solid var(--primary)', borderRadius: '12px', fontSize: '12px', color: 'white' }}>
                  {r}
                </button>
              )) : <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No active rooms.</span>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
          <button 
            onClick={login}
            style={{
              flex: 1, padding: '16px', borderRadius: '30px',
              background: '#0d6efd', color: 'white', 
              fontWeight: 700, fontSize: '15px'
            }}
          >
            LOGIN (SSO)
          </button>
          
          <button 
            onClick={handleJoin}
            disabled={isLoadingRooms}
            style={{
              flex: 1.5, padding: '16px', borderRadius: '30px',
              background: 'var(--primary)', color: 'white', 
              fontWeight: 700, fontSize: '15px',
              opacity: isLoadingRooms ? 0.5 : 1
            }}
          >
            JOIN GUEST
          </button>
        </div>
        
        <button 
          onClick={handleOffline}
          style={{
            width: '100%', padding: '16px', borderRadius: '30px',
            background: 'rgba(255,255,255,0.1)', color: 'white', 
            fontWeight: 600, fontSize: '15px'
          }}
        >
          OFFLINE MODE
        </button>
      </div>
    </div>
  );
}

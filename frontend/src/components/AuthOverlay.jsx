import React, { useState, useEffect } from 'react';
import { useNetworkStore } from '../store/useNetworkStore';
import { useAuthStore } from '../store/useAuthStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { socket } from '../lib/webtransport';
import { motion } from 'framer-motion';

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
    if (window.navigator.vibrate) window.navigator.vibrate(10);
    setGuestMode(nick);
    setRoom(roomId);
    socket.sendCommand('join', { nickname: nick, room_id: roomId });
  };

  const handleOffline = () => {
    if (window.navigator.vibrate) window.navigator.vibrate(10);
    setOffline(true);
    setGuestMode('Offline');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--bg-base)',
      display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'center',
      padding: '24px'
    }}>
      {/* Background Glow */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 50%, rgba(var(--dominant-color-rgb), 0.15) 0%, transparent 70%)', zIndex: -1 }} />

      <motion.h1 
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        style={{ color: 'white', fontSize: '38px', fontWeight: 900, marginBottom: '40px', letterSpacing: '-0.04em' }}
      >
        SyncMusic
      </motion.h1>

      <motion.div 
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="glass-panel" 
        style={{ padding: '32px', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: '380px', boxShadow: '0 20px 50px rgba(0,0,0,0.5)' }}
      >
        <div style={{ marginBottom: '20px' }}>
            <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-tertiary)', marginLeft: '4px', marginBottom: '8px', display: 'block', letterSpacing: '0.1em' }}>DISPLAY NAME</label>
            <input 
            type="text" 
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            placeholder="e.g. MusicLover"
            style={{
                width: '100%', padding: '16px', borderRadius: '14px',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                color: 'white', fontSize: '16px', outline: 'none', transition: 'border 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
            onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
            />
        </div>

        <div style={{ marginBottom: '28px' }}>
            <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-tertiary)', marginLeft: '4px', marginBottom: '8px', display: 'block', letterSpacing: '0.1em' }}>ROOM IDENTIFIER</label>
            <input 
            type="text" 
            value={roomId}
            onChange={e => setRoomId(e.target.value)}
            placeholder="global"
            style={{
                width: '100%', padding: '16px', borderRadius: '14px',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                color: 'white', fontSize: '16px', outline: 'none', transition: 'border 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
            onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
            />
        </div>

        <div style={{ marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-tertiary)', marginLeft: '4px', marginBottom: '10px', letterSpacing: '0.1em' }}>ACTIVE ROOMS</div>
          {isLoadingRooms ? (
            <div style={{ color: 'var(--primary)', fontSize: '12px', fontWeight: 600 }}>Scanning...</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {rooms.length > 0 ? rooms.map(r => (
                <button 
                    key={r} 
                    onClick={() => setRoomId(r)} 
                    style={{ 
                        padding: '8px 14px', background: 'var(--primary-glass)', 
                        border: '1px solid var(--primary)', borderRadius: '14px', 
                        fontSize: '12px', color: 'white', fontWeight: 700 
                    }}
                >
                  {r}
                </button>
              )) : <span style={{ color: 'var(--text-tertiary)', fontSize: '12px', fontWeight: 500 }}>No other rooms found.</span>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '14px', marginBottom: '14px' }}>
          <button 
            onClick={login}
            style={{
              flex: 1, padding: '18px', borderRadius: 'var(--radius-full)',
              background: 'rgba(255,255,255,0.1)', color: 'white', 
              fontWeight: 800, fontSize: '14px'
            }}
          >
            SSO LOGIN
          </button>
          
          <button 
            onClick={handleJoin}
            disabled={isLoadingRooms}
            style={{
              flex: 1.5, padding: '18px', borderRadius: 'var(--radius-full)',
              background: 'var(--primary)', color: 'black', 
              fontWeight: 800, fontSize: '14px',
              opacity: isLoadingRooms ? 0.5 : 1
            }}
          >
            JOIN AS GUEST
          </button>
        </div>
        
        <button 
          onClick={handleOffline}
          style={{
            width: '100%', padding: '18px', borderRadius: 'var(--radius-full)',
            background: 'transparent', color: 'var(--text-secondary)', 
            fontWeight: 700, fontSize: '14px', border: '1px solid rgba(255,255,255,0.1)'
          }}
        >
          USE OFFLINE (NO SYNC)
        </button>
      </motion.div>
    </div>
  );
}

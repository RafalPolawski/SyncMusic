import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useNetworkStore } from './store/useNetworkStore';
import { useAuthStore } from './store/useAuthStore';
import BottomNav from './components/BottomNav';
import MiniPlayer from './components/player/MiniPlayer';
import FullPlayer from './components/player/FullPlayer';
import LibraryView from './components/views/LibraryView';
import QueueView from './components/views/QueueView';
import SettingsView from './components/views/SettingsView';
import AuthOverlay from './components/AuthOverlay';
import AudioController from './components/player/AudioController';

export default function App() {
  const [activeTab, setActiveTab] = useState('library');
  const [isFullPlayerOpen, setFullPlayerOpen] = useState(false);
  
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthChecking = useAuthStore((state) => state.isChecking);
  const isGuestMode = useAuthStore((state) => state.isGuestMode);

  // Initialize Auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isAuthChecking) {
    return (
      <div style={{ 
        height: '100vh', display: 'flex', flexDirection: 'column', 
        alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' 
      }}>
        <div style={{ fontSize: '32px', fontWeight: 900, color: 'var(--primary)', letterSpacing: '-1px' }}>
          SyncMusic
        </div>
        <div style={{ marginTop: '20px', width: '30px', height: '2px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div style={{ width: '100%', height: '100%', background: 'var(--primary)', animation: 'ms-loading 1.5s infinite linear' }} />
        </div>
        <style>{`
            @keyframes ms-loading {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }
        `}</style>
      </div>
    );
  }

  const showAuthOverlay = !isAuthenticated && !isGuestMode;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' }}>
      <AudioController />
      
      {showAuthOverlay ? (
        <AuthOverlay />
      ) : (
        <>
          <main style={{ flex: 1, overflowY: 'auto', paddingBottom: '140px' }}>
            {activeTab === 'library' && <LibraryView />}
            {activeTab === 'queue' && <QueueView />}
            {activeTab === 'settings' && <SettingsView />}
          </main>

          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50 }}>
            <MiniPlayer onClick={() => setFullPlayerOpen(true)} />
            <BottomNav activeTab={activeTab} onChangeTab={setActiveTab} />
          </div>

          <FullPlayer 
            isOpen={isFullPlayerOpen} 
            onClose={() => setFullPlayerOpen(false)} 
          />
        </>
      )}
    </div>
  );
}

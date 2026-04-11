import React, { useEffect, useState } from 'react';
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
  
  const initNetwork = useNetworkStore((state) => state.initNetwork);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthChecking = useAuthStore((state) => state.isChecking);

  // Initialize Auth & Network on mount
  useEffect(() => {
    checkAuth().then((authStatus) => {
      // If we are authenticated, or we bypass as guest, connect WebTransport
      // For now, let AuthOverlay handle the bypass/login forcing.
    });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      
      {/* Views */}
      <main style={{ flex: 1, overflowY: 'auto', paddingBottom: '140px' }}>
        {activeTab === 'library' && <LibraryView />}
        {activeTab === 'queue' && <QueueView />}
        {activeTab === 'settings' && <SettingsView />}
      </main>

      {/* Floating Bottom UI */}
      <div style={{ position: 'fixed', bottom: 0, width: '100%', zIndex: 50 }}>
        <MiniPlayer onClick={() => setFullPlayerOpen(true)} />
        <BottomNav activeTab={activeTab} onChangeTab={setActiveTab} />
      </div>

      {/* Full Screen Player Drawer */}
      <FullPlayer 
        isOpen={isFullPlayerOpen} 
        onClose={() => setFullPlayerOpen(false)} 
      />

      {/* Login / Setup Overlay */}
      {(!isAuthenticated && !isAuthChecking) && <AuthOverlay />}

      {/* Headless Audio Engine */}
      <AudioController />
    </div>
  );
}

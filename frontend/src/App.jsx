import React, { useEffect, useState } from 'react';
import { useAuthStore } from './store/useAuthStore';
import { motion, AnimatePresence } from 'framer-motion';
import BottomNav from './components/BottomNav';
import MiniPlayer from './components/player/MiniPlayer';
import FullPlayer from './components/player/FullPlayer';
import LibraryView from './components/views/LibraryView';
import QueueView from './components/views/QueueView';
import SearchView from './components/views/SearchView';
import SettingsView from './components/views/SettingsView';
import AuthOverlay from './components/AuthOverlay';
import AudioController from './components/player/AudioController';

export default function App() {
  const [activeTab, setActiveTab] = useState('library');
  const [isFullPlayerOpen, setFullPlayerOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState(null);

  useEffect(() => {
    const handlePopState = (e) => {
      if (isFullPlayerOpen) {
        setFullPlayerOpen(false);
      } else if (selectedFolder) {
        setSelectedFolder(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isFullPlayerOpen, selectedFolder]);

  const openFullPlayer = () => {
    window.history.pushState({ level: 'player' }, '');
    setFullPlayerOpen(true);
  };

  const closeFullPlayer = () => {
    if (window.history.state?.level === 'player') {
      window.history.back();
    } else {
      setFullPlayerOpen(false);
    }
  };

  const openFolder = (folder) => {
    window.history.pushState({ level: 'folder', folder }, '');
    setSelectedFolder(folder);
  };

  const closeFolder = () => {
    if (window.history.state?.level === 'folder') {
      window.history.back();
    } else {
      setSelectedFolder(null);
    }
  };

  const handleChangeTab = (tab) => {
    if (tab === 'library') {
      setSelectedFolder(null); // Always go to root list when clicking Library icon
    }
    setActiveTab(tab);
  };
  
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthChecking = useAuthStore((state) => state.isChecking);
  const isGuestMode = useAuthStore((state) => state.isGuestMode);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (isAuthChecking) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
        <div style={{ fontSize: '32px', fontWeight: 900, color: 'var(--primary)', letterSpacing: '-1px' }}>SyncMusic</div>
        <div style={{ marginTop: '20px', width: '30px', height: '2px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div style={{ width: '100%', height: '100%', background: 'var(--primary)', animation: 'ms-loading 1.5s infinite linear' }} />
        </div>
        <style>{`@keyframes ms-loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
      </div>
    );
  }

  const showAuthOverlay = !isAuthenticated && !isGuestMode;

  const viewVariants = {
    initial: { opacity: 0, scale: 0.98 },
    enter: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 1.02 }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', overflow: 'hidden' }}>
      {showAuthOverlay ? (
        <AuthOverlay />
      ) : (
        <>
          <AudioController />
          <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab + (activeTab === 'library' && selectedFolder ? `-${selectedFolder}` : '')}
                variants={viewVariants}
                initial="initial"
                animate="enter"
                exit="exit"
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="view-container"
              >
                {activeTab === 'library' && (
                  <LibraryView
                    selectedFolder={selectedFolder}
                    onOpenFolder={openFolder}
                    onCloseFolder={closeFolder}
                  />
                )}
                {activeTab === 'search' && <SearchView />}
                {activeTab === 'queue' && <QueueView />}
                {activeTab === 'settings' && <SettingsView />}
              </motion.div>
            </AnimatePresence>
          </main>

          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50 }}>
            <MiniPlayer onClick={openFullPlayer} />
            <BottomNav activeTab={activeTab} onChangeTab={handleChangeTab} />
          </div>

          <FullPlayer 
            isOpen={isFullPlayerOpen} 
            onClose={closeFullPlayer} 
            onNavigate={handleChangeTab}
          />
        </>
      )}
    </div>
  );
}

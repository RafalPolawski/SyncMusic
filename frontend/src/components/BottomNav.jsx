import React from 'react';
import { Library, Search, Settings } from 'lucide-react';
import { useQueueStore } from '../store/useQueueStore';
import { motion } from 'framer-motion';

export default function BottomNav({ activeTab, onChangeTab }) {
  const queueLength = useQueueStore(state => state.queue.length);
  
  const tabs = [
    { id: 'library', label: 'Library', icon: Library },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  return (
    <div 
      className="glass-panel"
      style={{
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingBottom: 'var(--safe-bottom)',
        height: 'calc(70px + var(--safe-bottom))',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        zIndex: 10,
        borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
      }}
    >
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button 
            key={tab.id}
            onClick={() => {
                if (window.navigator.vibrate) window.navigator.vibrate(5);
                onChangeTab(tab.id);
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              color: isActive ? 'var(--primary)' : 'var(--text-tertiary)',
              gap: '6px',
              width: '80px',
              position: 'relative',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            <div style={{ position: 'relative' }}>
                <Icon size={26} strokeWidth={isActive ? 2.8 : 2} />
            </div>
            <span style={{ fontSize: '11px', fontWeight: isActive ? 800 : 500, letterSpacing: '0.02em' }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

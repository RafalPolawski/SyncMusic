import React from 'react';
import { Library, ListMusic, Settings } from 'lucide-react';

export default function BottomNav({ activeTab, onChangeTab }) {
  const tabs = [
    { id: 'library', label: 'Library', icon: Library },
    { id: 'queue', label: 'Queue', icon: ListMusic },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-around',
      alignItems: 'center',
      background: 'var(--bg-surface-elevated)',
      backdropFilter: 'var(--glass-blur)',
      paddingBottom: 'var(--safe-bottom)',
      height: '65px',
      borderTop: '1px solid rgba(255,255,255,0.05)'
    }}>
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button 
            key={tab.id}
            onClick={() => onChangeTab(tab.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              color: isActive ? 'var(--primary)' : 'var(--text-tertiary)',
              transition: 'color 0.2s',
              gap: '4px',
              width: '70px'
            }}
          >
            <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
            <span style={{ fontSize: '10px', fontWeight: isActive ? 600 : 500 }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

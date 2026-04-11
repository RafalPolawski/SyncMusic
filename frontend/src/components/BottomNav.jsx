import React from 'react';
import { Library, ListMusic, Settings } from 'lucide-react';

import { useQueueStore } from '../store/useQueueStore';

export default function BottomNav({ activeTab, onChangeTab }) {
  const queueLength = useQueueStore(state => state.queue.length);
  
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
              width: '70px',
              position: 'relative'
            }}
          >
            <div style={{ position: 'relative' }}>
                <Icon size={24} strokeWidth={isActive ? 2.5 : 2} />
                {tab.id === 'queue' && queueLength > 0 && (
                    <div style={{ 
                        position: 'absolute', top: '-4px', right: '-8px',
                        background: 'var(--primary)', color: 'var(--bg-base)',
                        fontSize: '9px', fontWeight: 'bold', padding: '2px 5px',
                        borderRadius: '10px', border: '2px solid var(--bg-surface-elevated)'
                    }}>
                        {queueLength > 99 ? '99+' : queueLength}
                    </div>
                )}
            </div>
            <span style={{ fontSize: '10px', fontWeight: isActive ? 600 : 500 }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

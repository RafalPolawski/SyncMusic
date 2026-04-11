import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';

export default function SettingsView() {
  const { syncEnabled, syncThreshold, setSyncSettings } = usePlayerStore();
  const { rescanLibrary, isScanning } = useLibraryStore();

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '20px' }}>Settings</h1>
      
      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '12px', marginBottom: '20px' }}>
        <h2 style={{ fontSize: '14px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '16px' }}>
          Synchronization
        </h2>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontWeight: 500 }}>Sync Enabled</span>
          <input 
            type="checkbox" 
            checked={syncEnabled} 
            onChange={(e) => setSyncSettings(e.target.checked, syncThreshold)} 
            style={{ width: '20px', height: '20px', accentColor: 'var(--primary)' }}
          />
        </div>

        <div style={{ opacity: syncEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontWeight: 500 }}>Hard-seek Threshold</span>
            <span style={{ color: 'var(--primary)' }}>{syncThreshold.toFixed(1)}s</span>
          </div>
          <input 
            type="range" 
            min="1" max="15" step="0.5" 
            value={syncThreshold}
            onChange={(e) => setSyncSettings(syncEnabled, parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--primary)' }}
          />
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '8px' }}>
            Time difference in seconds before snapping to server time.
          </p>
        </div>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '12px' }}>
        <h2 style={{ fontSize: '14px', color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: '16px' }}>
          Library
        </h2>
        <button 
          onClick={rescanLibrary}
          disabled={isScanning}
          style={{
            width: '100%', padding: '12px', 
            background: 'rgba(255,100,100,0.1)', color: '#ff6b6b', 
            borderRadius: '8px', fontWeight: 600,
            opacity: isScanning ? 0.5 : 1
          }}
        >
          {isScanning ? 'Scanning...' : 'Rescan Library'}
        </button>
      </div>
    </div>
  );
}

import React, { useEffect } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useCacheStore } from '../../store/useCacheStore';
import { Trash2, Database, ExternalLink, HardDrive } from 'lucide-react';

export default function SettingsView() {
  const { syncEnabled, syncThreshold, setSyncSettings } = usePlayerStore();
  const { rescanLibrary, isScanning } = useLibraryStore();
  const { initCacheListener, totalCacheSize, cachedPaths, activeJobs, clearCache } = useCacheStore();

  useEffect(() => {
    initCacheListener();
  }, [initCacheListener]);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const activeJobArray = Array.from(activeJobs.values());
  const totalProcessing = activeJobArray.reduce((acc, job) => acc + job.processed, 0);
  const totalFilesCount = activeJobArray.reduce((acc, job) => acc + job.total, 0);
  const isCashingGlobal = activeJobs.size > 0;

  return (
    <div style={{ padding: '24px', paddingBottom: '100px', maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '32px', fontWeight: 800, marginBottom: '24px' }}>Settings</h1>
      
      {/* Synchronization Section */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '12px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px', fontWeight: 700 }}>
          Playback Synchronization
        </h2>
        <div style={{ background: 'var(--bg-surface)', padding: '20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <span style={{ fontWeight: 600 }}>Sync with Server</span>
            <input 
                type="checkbox" 
                checked={syncEnabled} 
                onChange={(e) => setSyncSettings(e.target.checked, syncThreshold)} 
                style={{ width: '24px', height: '24px', accentColor: 'var(--primary)', cursor: 'pointer' }}
            />
            </div>

            <div style={{ opacity: syncEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontWeight: 600, fontSize: '14px' }}>Hard-seek Threshold</span>
                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>{syncThreshold.toFixed(1)}s</span>
            </div>
            <input 
                type="range" 
                min="0.5" max="10" step="0.5" 
                value={syncThreshold}
                onChange={(e) => setSyncSettings(syncEnabled, parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)', height: '6px', borderRadius: '3px' }}
            />
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.5' }}>
                Tolerated delay before the player forces synchronization with the server time. Smaller = tighter sync, but more "jumps" on poor network.
            </p>
            </div>
        </div>
      </section>

      {/* Storage & PWA Cache Section */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '12px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px', fontWeight: 700 }}>
          Offline Storage (PWA)
        </h2>
        <div style={{ background: 'var(--bg-surface)', padding: '20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
                <div style={{ background: 'rgba(29, 185, 84, 0.1)', padding: '10px', borderRadius: '12px', marginRight: '16px' }}>
                    <HardDrive size={24} color="var(--primary)" />
                </div>
                <div>
                    <div style={{ fontWeight: 700, fontSize: '18px' }}>{formatBytes(totalCacheSize)}</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{cachedPaths.size} tracks available offline</div>
                </div>
            </div>

            {isCashingGlobal && (
                <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', fontWeight: 600 }}>
                        <span>Downloading tracks...</span>
                        <span>{totalProcessing} / {totalFilesCount}</span>
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${(totalProcessing/totalFilesCount)*100}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s' }} />
                    </div>
                </div>
            )}

            <button 
                onClick={clearCache}
                style={{
                    width: '100%', padding: '14px', 
                    background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', 
                    borderRadius: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    border: '1px solid rgba(255,255,255,0.05)'
                }}
            >
                <Trash2 size={18} /> Clear Data
            </button>
        </div>
      </section>

      {/* Library Section */}
      <section>
        <h2 style={{ fontSize: '12px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px', fontWeight: 700 }}>
          Backend Library
        </h2>
        <div style={{ background: 'var(--bg-surface)', padding: '20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <button 
                onClick={rescanLibrary}
                disabled={isScanning}
                style={{
                    width: '100%', padding: '14px', 
                    background: 'rgba(255,100,100,0.1)', color: '#ff6b6b', 
                    borderRadius: '12px', fontWeight: 700,
                    opacity: isScanning ? 0.5 : 1, transition: 'all 0.2s'
                }}
            >
                {isScanning ? 'Syncing with Server...' : 'Trigger Global Rescan'}
            </button>
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '12px', textAlign: 'center' }}>
                Re-scans the physical folders on the server to detect new music files.
            </p>
        </div>
      </section>
      
      <div style={{ marginTop: '40px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '12px' }}>
        SyncMusic React v1.2.0 • Build 2026.04
      </div>
    </div>
  );
}

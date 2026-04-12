import React, { useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useCacheStore } from '../../store/useCacheStore';
import { useNetworkStore } from '../../store/useNetworkStore';
import { Trash2, Database, HardDrive, Download, CheckCircle2, Wifi, Info, Activity } from 'lucide-react';

export default function SettingsView() {
  const { syncEnabled, syncThreshold, setSyncSettings, drift, offlineMode, setOffline } = usePlayerStore();
  const { rescanLibrary, isScanning, groups } = useLibraryStore();
  const { initCacheListener, totalCacheSize, cachedPaths, activeJobs, clearCache, cacheSongs } = useCacheStore();
  const { rtt } = useNetworkStore();

  useEffect(() => {
    initCacheListener();
  }, [initCacheListener]);

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isCachingGlobal = activeJobs.size > 0;

  const folderCacheStats = useMemo(() => {
    const stats = {};
    Object.entries(groups).forEach(([folder, songs]) => {
      const cached = songs.filter(s => cachedPaths.has(s.path)).length;
      stats[folder] = { 
        total: songs.length, 
        cached, 
        fullyDone: songs.length > 0 && cached === songs.length,
        sizeEstimate: songs.length * 6 // Rough estimation 6MB/track Opus
      };
    });
    return stats;
  }, [groups, cachedPaths]);

  const totalLibraryCount = useMemo(() =>
    Object.values(groups).reduce((acc, songs) => acc + songs.length, 0),
  [groups]);

  const allCached = totalLibraryCount > 0 && cachedPaths.size >= totalLibraryCount;

  const handleCacheAll = () => {
    if (allCached || isCachingGlobal) return;
    if (!window.confirm('Do you want to download all tracks to offline storage? This may take a while.')) return;
    
    Object.entries(groups).forEach(([folder, songs]) => {
        cacheSongs(songs, folder);
    });
  };

  return (
    <div style={{ padding: '24px', paddingBottom: '120px', maxWidth: '640px', margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      <h1 style={{ fontSize: '32px', fontWeight: 800, marginBottom: '28px' }}>Settings</h1>
      
      {/* Real-time Diagnostics */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '16px', fontWeight: 700 }}>
          Diagnostics & Network
        </h2>
        <div className="glass-panel" style={{ padding: '20px', borderRadius: 'var(--radius-md)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: 600 }}>NETWORK LATENCY</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '18px', fontWeight: 700 }}>
                    <Wifi size={18} color={rtt === 'OFFLINE' ? '#ff6b6b' : 'var(--primary)'} />
                    {rtt === 'OFFLINE' ? 'Offline' : `${Math.round(rtt)}ms`}
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: 600 }}>SYNC DRIFT (L-S)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '18px', fontWeight: 700 }}>
                    <Activity size={18} color={drift > 300 ? '#ff6b6b' : 'var(--primary)'} />
                    {offlineMode ? '--' : `${drift}ms`}
                </div>
            </div>
            <div style={{ gridColumn: '1 / span 2', marginTop: '8px', padding: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: '12px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                <div style={{ fontWeight: 700, color: 'white', marginBottom: '4px' }}>What is Sync Drift?</div>
                Difference between Server time and your local Audio time. If it exceeds <b>{syncThreshold}s</b>, a hard-sync seek is triggered.
            </div>
        </div>
      </section>

      {/* Sync Section */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '16px', fontWeight: 700 }}>
          Playback Synchronization
        </h2>
        <div className="glass-panel" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <span style={{ fontWeight: 600 }}>Sync with Server</span>
              <input 
                type="checkbox" 
                checked={syncEnabled} 
                onChange={(e) => setSyncSettings(e.target.checked, syncThreshold)} 
                style={{ width: '22px', height: '22px', accentColor: 'var(--primary)', cursor: 'pointer' }}
              />
            </div>
            <div style={{ opacity: syncEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontWeight: 600, fontSize: '14px' }}>Hard-seek Threshold</span>
                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>{syncThreshold.toFixed(1)}s</span>
              </div>
              <input 
                type="range" min="0.5" max="10" step="0.5" 
                value={syncThreshold}
                onChange={(e) => setSyncSettings(syncEnabled, parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)', height: '4px', cursor: 'pointer' }}
              />
            </div>
        </div>
      </section>

      {/* Offline Storage Section */}
      <section style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700 }}>
                Offline Storage
            </h2>
            <button 
                onClick={() => setOffline(!offlineMode)}
                style={{ fontSize: '10px', fontWeight: 800, padding: '4px 10px', borderRadius: '6px', background: offlineMode ? 'var(--primary)' : 'rgba(255,255,255,0.1)', color: offlineMode ? 'black' : 'white' }}
            >
                {offlineMode ? 'OFFLINE MODE ON' : 'GO OFFLINE'}
            </button>
        </div>
        
        <div className="glass-panel" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '24px' }}>
                <div style={{ background: 'var(--primary-glass)', padding: '12px', borderRadius: '14px', marginRight: '16px' }}>
                    <HardDrive size={26} color="var(--primary)" />
                </div>
                <div>
                    <div style={{ fontWeight: 800, fontSize: '20px' }}>{formatBytes(totalCacheSize)} Used</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {cachedPaths.size} / {totalLibraryCount} tracks available offline
                    </div>
                </div>
            </div>

            {/* Per-folder cache status */}
            {Object.entries(folderCacheStats).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
                {Object.entries(folderCacheStats).map(([folder, stats]) => {
                  const job = activeJobs.get(folder);
                  const jobProgress = job ? Math.round((job.processed / job.total) * 100) : null;
                  const pct = stats.total > 0 ? stats.cached / stats.total : 0;
                  
                  return (
                    <div key={folder} style={{ fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ color: stats.fullyDone ? 'var(--primary)' : 'var(--text-primary)', fontWeight: 600 }}>
                          {folder} {!stats.fullyDone && `(~${stats.sizeEstimate} MB)`}
                        </span>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', fontWeight: 700 }}>
                            {job ? `CACHING ${job.processed}/${job.total}` : `${stats.cached} / ${stats.total}`}
                        </span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
                        <motion.div 
                          initial={false}
                          animate={{ width: `${jobProgress !== null ? jobProgress : pct * 100}%` }}
                          style={{ 
                            height: '100%', 
                            background: stats.fullyDone ? 'var(--primary)' : 'var(--text-tertiary)',
                          }} 
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px' }}>
                <button 
                    onClick={handleCacheAll}
                    disabled={allCached || isCachingGlobal}
                    style={{
                        flex: 1, padding: '16px', 
                        background: 'var(--primary)', 
                        color: 'black', 
                        borderRadius: 'var(--radius-md)', fontWeight: 800, gap: '8px',
                        opacity: allCached || isCachingGlobal ? 0.4 : 1,
                        cursor: allCached || isCachingGlobal ? 'not-allowed' : 'pointer'
                    }}
                >
                    {allCached ? <CheckCircle2 size={18} /> : <Download size={18} />}
                    {allCached ? 'COMPLETE' : isCachingGlobal ? 'CACHING...' : 'CACHE ALL'}
                </button>
                <button 
                    onClick={() => {
                        if (window.confirm('Delete all offline data?')) clearCache();
                    }}
                    style={{
                        padding: '16px',
                        background: 'rgba(255,100,100,0.1)', color: '#ff6b6b', 
                        borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,100,100,0.2)'
                    }}
                >
                    <Trash2 size={20} />
                </button>
            </div>
        </div>
      </section>

      {/* Library Section */}
      <section>
        <h2 style={{ fontSize: '11px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '16px', fontWeight: 700 }}>
          Backend Library
        </h2>
        <div className="glass-panel" style={{ padding: '20px', borderRadius: 'var(--radius-md)' }}>
            <button 
                onClick={() => {
                    if (window.confirm('Trigger library rescan?')) rescanLibrary();
                }}
                disabled={isScanning}
                style={{
                    width: '100%', padding: '16px', 
                    background: 'rgba(255,255,255,0.05)',
                    color: 'white',
                    borderRadius: 'var(--radius-md)', fontWeight: 700, gap: '10px',
                    border: '1px solid rgba(255,255,255,0.1)',
                }}
            >
                <Database size={18} />
                {isScanning ? 'SCANNING...' : 'RESCAN LIBRARY'}
            </button>
        </div>
      </section>
    </div>
  );
}

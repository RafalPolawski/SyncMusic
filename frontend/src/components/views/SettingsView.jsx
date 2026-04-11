import React, { useEffect, useMemo } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useCacheStore } from '../../store/useCacheStore';
import { Trash2, Database, ExternalLink, HardDrive, Download, CheckCircle2 } from 'lucide-react';

export default function SettingsView() {
  const { syncEnabled, syncThreshold, setSyncSettings } = usePlayerStore();
  const { rescanLibrary, isScanning } = useLibraryStore();
  const { initCacheListener, totalCacheSize, cachedPaths, activeJobs, clearCache, cacheSongs } = useCacheStore();

  // Subscribe to groups via hook so component re-renders when library loads
  const groups = useLibraryStore(state => state.groups);

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

  const activeJobArray = Array.from(activeJobs.values());
  const totalProcessing = activeJobArray.reduce((acc, job) => acc + job.processed, 0);
  const totalJobFilesCount = activeJobArray.reduce((acc, job) => acc + job.total, 0);
  const isCachingGlobal = activeJobs.size > 0;

  // Derived from reactive Zustand state
  const folderCacheStats = useMemo(() => {
    const stats = {};
    Object.entries(groups).forEach(([folder, songs]) => {
      const cached = songs.filter(s => cachedPaths.has(s.path)).length;
      stats[folder] = { total: songs.length, cached, fullyDone: songs.length > 0 && cached === songs.length };
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
    const allSongs = Object.values(groups).flat();
    if (allSongs.length > 0) cacheSongs(allSongs, 'cache-all');
  };

  return (
    <div style={{ padding: '24px', paddingBottom: '100px', maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '32px', fontWeight: 800, marginBottom: '24px' }}>Settings</h1>
      
      {/* Sync Section */}
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
                type="range" min="0.5" max="10" step="0.5" 
                value={syncThreshold}
                onChange={(e) => setSyncSettings(syncEnabled, parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary)', height: '6px', borderRadius: '3px' }}
              />
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.5' }}>
                Tolerated delay before the player forces synchronization with the server time.
              </p>
            </div>
        </div>
      </section>

      {/* Offline Storage Section */}
      <section style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '12px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px', fontWeight: 700 }}>
          Offline Storage (PWA)
        </h2>
        <div style={{ background: 'var(--bg-surface)', padding: '20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
            {/* Storage summary */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
                <div style={{ background: 'rgba(29, 185, 84, 0.1)', padding: '10px', borderRadius: '12px', marginRight: '16px' }}>
                    <HardDrive size={24} color="var(--primary)" />
                </div>
                <div>
                    <div style={{ fontWeight: 700, fontSize: '18px' }}>{formatBytes(totalCacheSize)}</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                      {cachedPaths.size} / {totalLibraryCount} tracks available offline
                    </div>
                </div>
                {allCached && (
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--primary)', fontSize: '13px', fontWeight: 600 }}>
                    <CheckCircle2 size={18} />
                    All cached
                  </div>
                )}
            </div>

            {/* Per-folder cache status */}
            {Object.entries(folderCacheStats).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
                {Object.entries(folderCacheStats).map(([folder, stats]) => {
                  const job = activeJobs.get(folder) || activeJobs.get('cache-all');
                  const jobProgress = job ? Math.round((job.processed / job.total) * 100) : null;
                  const pct = stats.total > 0 ? stats.cached / stats.total : 0;
                  return (
                    <div key={folder} style={{ fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ color: stats.fullyDone ? 'var(--primary)' : 'var(--text-secondary)', fontWeight: stats.fullyDone ? 600 : 400 }}>
                          {stats.fullyDone && '✓ '}{folder}
                        </span>
                        <span style={{ color: 'var(--text-tertiary)' }}>{stats.cached}/{stats.total}</span>
                      </div>
                      <div style={{ height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${jobProgress !== null ? jobProgress : pct * 100}%`, 
                          height: '100%', 
                          background: stats.fullyDone ? 'var(--primary)' : 'rgba(29, 185, 84, 0.5)',
                          transition: 'width 0.4s' 
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Global progress bar when caching */}
            {isCachingGlobal && (
                <div style={{ marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '6px' }}>
                        <span>Downloading... {totalProcessing} / {totalJobFilesCount}</span>
                        <span>{totalJobFilesCount > 0 ? Math.round((totalProcessing / totalJobFilesCount) * 100) : 0}%</span>
                    </div>
                    <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${(totalProcessing / totalJobFilesCount) * 100}%`, height: '100%', background: 'var(--primary)', transition: 'width 0.3s' }} />
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                <button 
                    onClick={handleCacheAll}
                    disabled={allCached || isCachingGlobal}
                    style={{
                        flex: 2, padding: '14px', 
                        background: allCached ? 'rgba(29, 185, 84, 0.08)' : isCachingGlobal ? 'rgba(255,255,255,0.05)' : 'rgba(29, 185, 84, 0.1)', 
                        color: allCached ? 'var(--primary)' : isCachingGlobal ? 'var(--text-tertiary)' : 'var(--primary)', 
                        borderRadius: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                        border: allCached ? '1px solid var(--primary)' : '1px solid rgba(29, 185, 84, 0.2)',
                        cursor: allCached || isCachingGlobal ? 'not-allowed' : 'pointer'
                    }}
                >
                    {allCached ? <><CheckCircle2 size={18} /> All Playlists Cached</> : <><Download size={18} /> {isCachingGlobal ? 'Caching...' : 'Cache All Playlists'}</>}
                </button>
                <button 
                    onClick={() => {
                        if (window.confirm('Are you sure you want to delete all offline tracks and cache? This cannot be undone.')) {
                            clearCache();
                        }
                    }}
                    style={{
                        flex: 1, padding: '14px', 
                        background: 'rgba(255,100,100,0.1)', color: '#ff6b6b', 
                        borderRadius: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                        border: '1px solid rgba(255,100,100,0.2)'
                    }}
                >
                    <Trash2 size={18} /> Clear
                </button>
            </div>
        </div>
      </section>

      {/* Library Section */}
      <section>
        <h2 style={{ fontSize: '12px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px', fontWeight: 700 }}>
          Backend Library
        </h2>
        <div style={{ background: 'var(--bg-surface)', padding: '20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <button 
                onClick={() => {
                    if (window.confirm('Triggering a global rescan is intensive. Continue?')) {
                        rescanLibrary();
                    }
                }}
                disabled={isScanning}
                style={{
                    width: '100%', padding: '14px', 
                    background: isScanning ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)',
                    color: isScanning ? 'var(--text-tertiary)' : 'white',
                    borderRadius: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                    border: '1px solid rgba(255,255,255,0.08)', cursor: isScanning ? 'not-allowed' : 'pointer'
                }}
            >
                <Database size={18} />
                {isScanning ? 'Scanning library...' : 'Rescan Library'}
            </button>
        </div>
      </section>
    </div>
  );
}

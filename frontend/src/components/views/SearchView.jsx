import React, { useState } from 'react';
import { Search, History, Music, Mic2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLibraryStore } from '../../store/useLibraryStore';
import { socket } from '../../lib/webtransport';

export default function SearchView() {
    const [query, setQuery] = useState('');
    const songs = useLibraryStore(state => state.songs);

    const filtered = query.length > 0 
        ? songs.filter(s => 
            s.title.toLowerCase().includes(query.toLowerCase()) || 
            s.artist.toLowerCase().includes(query.toLowerCase())
          ).slice(0, 20)
        : [];

    const handlePlay = (song) => {
        socket.sendCommand('load', {
            song: song.path,
            title: song.title,
            artist: song.artist,
            folder: song.path.includes('/') ? song.path.split('/')[0] : 'Loose Tracks',
            is_queue: false
        });
    };

    return (
        <div style={{ padding: '24px 20px', height: '100%', overflowY: 'auto', paddingBottom: '100px' }}>
            <h1 style={{ fontSize: '32px', fontWeight: 900, color: 'white', marginBottom: '24px', letterSpacing: '-1px' }}>
                Search
            </h1>

            {/* Search Bar */}
            <div style={{ 
                position: 'relative', 
                marginBottom: '32px',
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '16px',
                padding: '4px',
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
            }}>
                <Search size={20} style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
                <input 
                    type="text" 
                    placeholder="Artists, songs, or folders"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{
                        width: '100%',
                        background: 'transparent',
                        border: 'none',
                        padding: '12px 12px 12px 48px',
                        color: 'white',
                        fontSize: '16px',
                        fontWeight: 500,
                        outline: 'none'
                    }}
                />
            </div>

            {query.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {filtered.length > 0 ? filtered.map(song => (
                        <motion.div 
                            key={song.path}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            onClick={() => handlePlay(song)}
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '14px', 
                                padding: '12px', 
                                borderRadius: '14px', 
                                cursor: 'pointer',
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid rgba(255,255,255,0.04)'
                            }}
                            whileTap={{ background: 'rgba(255,255,255,0.08)', scale: 0.98 }}
                        >
                            <div style={{ 
                                width: '52px', height: '52px', borderRadius: '10px', 
                                background: 'rgba(255,255,255,0.05)', display: 'flex', 
                                alignItems: 'center', justifyContent: 'center',
                                overflow: 'hidden'
                            }}>
                                <img 
                                    src={`/api/cover?song=${encodeURIComponent(song.path)}`} 
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                                    alt="" 
                                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
                                <Music size={22} color="var(--text-tertiary)" style={{ position: 'absolute' }} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, color: 'white', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</div>
                                <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.artist}</div>
                            </div>
                        </motion.div>
                    )) : (
                        <div style={{ textAlign: 'center', padding: '60px 40px', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                            <Search size={40} opacity={0.2} />
                            <div style={{ fontWeight: 500 }}>No results for "{query}"</div>
                        </div>
                    )}
                </div>
            ) : (
                <div style={{ height: '50vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', opacity: 0.5 }}>
                    <Music size={48} strokeWidth={1.5} style={{ marginBottom: '16px' }} />
                    <p style={{ fontWeight: 600, fontSize: '14px', letterSpacing: '0.05em' }}>FIND YOUR FAVORITE MUSIC</p>
                </div>
            )}
        </div>
    );
}

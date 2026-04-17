import React, { useState } from 'react';
import { Search, History, Music, Mic2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLibraryStore } from '../../store/useLibraryStore';
import { socket } from '../../lib/webtransport';

export default function SearchView() {
    const [query, setQuery] = useState('');
    const songs = useLibraryStore(state => state.songs);

    const filtered = query.length > 1 
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

            {query.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                   {/* Suggestion Categories */}
                   <div>
                       <h3 style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '16px' }}>
                           Browse All
                       </h3>
                       <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                           {[
                               { label: 'Recent', icon: History, color: '#FF5722' },
                               { label: 'Artists', icon: Mic2, color: '#E91E63' },
                               { label: 'Tracks', icon: Music, color: '#3F51B5' },
                               { label: 'Folders', icon: Music, color: '#4CAF50' }
                           ].map(cat => (
                               <motion.div 
                                    key={cat.label}
                                    whileTap={{ scale: 0.95 }}
                                    style={{ 
                                        height: '90px', 
                                        background: `linear-gradient(135deg, ${cat.color}aa, ${cat.color}66)`, 
                                        borderRadius: '16px',
                                        padding: '16px',
                                        position: 'relative',
                                        cursor: 'pointer',
                                        overflow: 'hidden',
                                        border: '1px solid rgba(255,255,255,0.1)'
                                    }}
                               >
                                   <span style={{ fontWeight: 800, fontSize: '16px', color: 'white' }}>{cat.label}</span>
                                   <cat.icon size={48} style={{ position: 'absolute', right: '-10px', bottom: '-10px', opacity: 0.3, transform: 'rotate(-15deg)' }} />
                               </motion.div>
                           ))}
                       </div>
                   </div>
                </div>
            ) : (
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
                                padding: '10px', 
                                borderRadius: '12px', 
                                cursor: 'pointer',
                                background: 'rgba(255,255,255,0.03)'
                            }}
                            whileTap={{ background: 'rgba(255,255,255,0.08)' }}
                        >
                            <div style={{ 
                                width: '48px', height: '48px', borderRadius: '8px', 
                                background: 'rgba(255,255,255,0.05)', display: 'flex', 
                                alignItems: 'center', justifyContent: 'center' 
                            }}>
                                <Music size={20} color="var(--text-tertiary)" />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</div>
                                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.artist}</div>
                            </div>
                        </motion.div>
                    )) : (
                        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)' }}>
                            No results for "{query}"
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

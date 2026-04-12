import React, { useRef, useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function ProgressBar() {
    const currentTime = usePlayerStore(state => state.currentTime);
    const duration = usePlayerStore(state => state.duration);
    const [isInteracting, setIsInteracting] = useState(false);
    const isDragging = useRef(false);

    const seek = useCallback((e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (window.navigator.vibrate) window.navigator.vibrate(5);
        socket.sendCommand('seek', { time: percent * duration });
    }, [duration]);

    const handleStart = (e) => {
        isDragging.current = true;
        setIsInteracting(true);
        seek(e);
    };

    const handleMove = (e) => {
        if (!isDragging.current) return;
        seek(e);
    };

    const handleEnd = (e) => {
        if (!isDragging.current) return;
        isDragging.current = false;
        setIsInteracting(false);
        seek(e);
    };

    const formatTime = (t) => {
        if (!t || isNaN(t)) return '0:00';
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div style={{ marginTop: '12px', marginBottom: '12px', userSelect: 'none' }}>
            <div 
                onMouseDown={handleStart}
                onMouseMove={handleMove}
                onMouseUp={handleEnd}
                onMouseLeave={handleEnd}
                onTouchStart={handleStart}
                onTouchMove={handleMove}
                onTouchEnd={handleEnd}
                style={{ 
                    width: '100%', height: '44px',
                    display: 'flex', alignItems: 'center',
                    cursor: 'pointer', position: 'relative'
                }}
            >
                {/* Track Background */}
                <div style={{
                    width: '100%',
                    height: '8px', background: 'rgba(255,255,255,0.08)',
                    borderRadius: 'var(--radius-full)', position: 'relative'
                }}>
                    {/* Fill */}
                    <motion.div 
                        initial={false}
                        animate={{ width: `${progressPercent}%` }}
                        transition={{ type: 'tween', ease: 'linear', duration: 0.1 }}
                        style={{
                            height: '100%',
                            background: 'linear-gradient(to right, var(--dominant-color), #fff)',
                            borderRadius: 'var(--radius-full)',
                            position: 'relative',
                            boxShadow: `0 0 20px rgba(var(--dominant-color-rgb), 0.5)`
                        }}
                    >
                        {/* Thumb Wrapper - Robust Centering */}
                        <motion.div 
                            animate={{ scale: isInteracting ? 1.8 : 1 }}
                            style={{
                                position: 'absolute',
                                top: '50%',
                                right: '-8px',
                                width: '16px',
                                height: '16px',
                                marginTop: '-8px', // Perfect center for 16px dot on 8px track
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                zIndex: 10
                            }}
                        >
                            <div style={{
                                width: '100%',
                                height: '100%',
                                borderRadius: '50%',
                                background: 'white',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
                                border: '4px solid var(--bg-base)',
                            }} />
                        </motion.div>
                    </motion.div>
                </div>
            </div>
            
            <div style={{ 
                display: 'flex', justifyContent: 'space-between', 
                marginTop: '-12px', fontSize: '11px', 
                color: 'var(--text-secondary)', fontWeight: 800,
                letterSpacing: '0.05em', opacity: 0.8
            }}>
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
            </div>
        </div>
    );
}

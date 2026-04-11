import React, { useRef, useCallback } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function ProgressBar() {
    const currentTime = usePlayerStore(state => state.currentTime);
    const duration = usePlayerStore(state => state.duration);
    const isDragging = useRef(false);

    const seek = useCallback((e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        socket.sendCommand('seek', { time: percent * duration });
    }, [duration]);

    const handleMouseDown = (e) => {
        isDragging.current = true;
        seek(e);
    };

    const handleMouseMove = (e) => {
        if (!isDragging.current) return;
        seek(e);
    };

    const handleMouseUp = (e) => {
        if (!isDragging.current) return;
        isDragging.current = false;
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
        <div style={{ marginTop: '30px', marginBottom: '20px', userSelect: 'none' }}>
            <div 
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onTouchStart={handleMouseDown}
                onTouchMove={handleMouseMove}
                onTouchEnd={handleMouseUp}
                style={{ 
                    width: '100%', height: '20px',
                    display: 'flex', alignItems: 'center',
                    cursor: 'pointer', position: 'relative'
                }}
            >
                {/* Track */}
                <div style={{
                    position: 'absolute', left: 0, right: 0,
                    height: '4px', background: 'rgba(255,255,255,0.15)',
                    borderRadius: '2px', overflow: 'visible'
                }}>
                    {/* Fill */}
                    <div style={{
                        width: `${progressPercent}%`,
                        height: '100%',
                        background: 'var(--primary)',
                        borderRadius: '2px',
                        position: 'relative'
                    }}>
                        {/* Thumb dot */}
                        <div style={{
                            position: 'absolute',
                            right: '-6px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            background: 'white',
                            boxShadow: '0 0 4px rgba(0,0,0,0.4)',
                            flexShrink: 0
                        }} />
                    </div>
                </div>
            </div>
            
            <div style={{ 
                display: 'flex', justifyContent: 'space-between', 
                marginTop: '4px', fontSize: '13px', 
                color: 'var(--text-tertiary)', fontWeight: 500 
            }}>
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
            </div>
        </div>
    );
}

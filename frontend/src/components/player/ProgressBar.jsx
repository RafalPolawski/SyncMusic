import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function ProgressBar() {
    // We only subscribe to these specific properties to optimize FullPlayer performance
    const currentTime = usePlayerStore(state => state.currentTime);
    const duration = usePlayerStore(state => state.duration);

    const handleSeek = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        socket.sendCommand('seek', { time: percent * duration });
    };

    const formatTime = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const progressPercent = (currentTime / (duration || 1)) * 100;

    return (
        <div style={{ marginTop: '30px', marginBottom: '20px' }}>
            <div 
                onClick={handleSeek}
                style={{ 
                    width: '100%', height: '8px', background: 'rgba(255,255,255,0.1)', 
                    borderRadius: '4px', cursor: 'pointer', position: 'relative',
                    overflow: 'hidden'
                }}
            >
                {/* Progress Fill */}
                <div 
                    style={{ 
                        width: `${progressPercent}%`, 
                        height: '100%', 
                        background: 'var(--primary)', 
                        borderRadius: '4px', 
                        transition: 'width 0.1s linear' 
                    }} 
                />
            </div>
            
            <div style={{ 
                display: 'flex', justifyContent: 'space-between', 
                marginTop: '12px', fontSize: '13px', 
                color: 'var(--text-tertiary)', fontWeight: 500 
            }}>
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
            </div>
        </div>
    );
}

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { usePlayerStore } from '../../store/usePlayerStore';
import { socket } from '../../lib/webtransport';

export default function ProgressBar() {
    const currentTime = usePlayerStore(state => state.currentTime || 0);
    const duration = usePlayerStore(state => state.duration || 0);
    const isPlaying = usePlayerStore(state => state.isPlaying);
    
    // Internal States
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubTime, setScrubTime] = useState(0);
    const [smoothTime, setSmoothTime] = useState(currentTime || 0);
    const [isHovered, setIsHovered] = useState(false);
    
    const containerRef = useRef(null);
    const lastEmitTime = useRef(0);
    const lastSeekTime = useRef(0);

    // Sync UI with store
    useEffect(() => {
        if (isScrubbing) return;
        
        // Sync Lock: Ignore store updates shortly after a seek
        const now = Date.now();
        if (now - lastSeekTime.current < 1000) {
            if (Math.abs(currentTime - scrubTime) < 1.0) {
                lastSeekTime.current = 0;
            } else {
                return;
            }
        }
        setSmoothTime(currentTime);
    }, [currentTime, isScrubbing, scrubTime]);

    // Buttery Smooth Playback Loop
    useEffect(() => {
        if (!isPlaying || isScrubbing) return;

        let frame;
        let lastTimestamp = performance.now();

        const tick = (now) => {
            const delta = (now - lastTimestamp) / 1000;
            lastTimestamp = now;
            
            setSmoothTime(prev => {
                const next = (prev || 0) + delta;
                return (next > duration) ? duration : next;
            });
            frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [isPlaying, isScrubbing, duration]);

    // Centralized Event Handler for Position
    const calculateTimeFromEvent = useCallback((e) => {
        if (!containerRef.current) return 0;
        const rect = containerRef.current.getBoundingClientRect();
        
        let clientX = 0;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            clientX = e.changedTouches[0].clientX;
        } else {
            clientX = e.clientX;
        }
        
        if (typeof clientX !== 'number' || isNaN(clientX)) return 0;

        const percent = Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width || 1)));
        const totalDuration = duration || 0;
        const result = percent * totalDuration;
        return isNaN(result) ? 0 : result;
    }, [duration]);

    // Window Listeners during Scrubbing
    useEffect(() => {
        if (!isScrubbing) return;

        const onMove = (e) => {
            if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
            const time = calculateTimeFromEvent(e);
            setScrubTime(time);
            setSmoothTime(time);

            const now = Date.now();
            if (now - lastEmitTime.current > 150) {
                socket.sendCommand('seek', { time });
                lastEmitTime.current = now;
            }
        };

        const onEnd = (e) => {
            const time = calculateTimeFromEvent(e);
            setIsScrubbing(false);
            setScrubTime(time);
            setSmoothTime(time);
            lastSeekTime.current = Date.now();
            socket.sendCommand('seek', { time });
            if (window.navigator.vibrate) window.navigator.vibrate(12);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);

        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onEnd);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onEnd);
            window.removeEventListener('touchcancel', onEnd);
        };
    }, [isScrubbing, calculateTimeFromEvent]);

    const handleStart = (e) => {
        if (e.type === 'touchstart' && e.cancelable) e.preventDefault();
        const time = calculateTimeFromEvent(e);
        setIsScrubbing(true);
        setScrubTime(time);
        setSmoothTime(time);
        if (window.navigator.vibrate) window.navigator.vibrate(8);
    };

    const formatTime = (t) => {
        const totalSeconds = isNaN(t) ? 0 : t;
        const m = Math.floor(totalSeconds / 60);
        const s = Math.floor(totalSeconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const displayTime = isScrubbing ? scrubTime : smoothTime;
    const progressPercent = duration > 0 ? (displayTime / duration) * 100 : 0;
    const safePercent = isNaN(progressPercent) ? 0 : progressPercent;

    return (
        <div 
            style={{ marginTop: '16px', marginBottom: '8px', userSelect: 'none' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div 
                ref={containerRef}
                onMouseDown={handleStart}
                onTouchStart={handleStart}
                style={{ 
                    width: '100%', height: '32px',
                    display: 'flex', alignItems: 'center',
                    cursor: 'pointer', position: 'relative',
                    touchAction: 'none'
                }}
            >
                <motion.div 
                    animate={{ height: isHovered || isScrubbing ? 6 : 4 }}
                    style={{
                        width: '100%', background: 'rgba(255,255,255,0.1)',
                        borderRadius: '10px', position: 'relative'
                    }}
                >
                    <div 
                        style={{
                            width: `${safePercent}%`, height: '100%',
                            background: 'white', borderRadius: '10px',
                            position: 'relative',
                            boxShadow: isScrubbing ? '0 0 30px rgba(255,255,255,0.5)' : 'none',
                        }}
                    >
                        <div style={{
                            position: 'absolute', inset: 0,
                            background: 'var(--dominant-color)', opacity: 0.7,
                            borderRadius: '10px', filter: 'blur(6px)', zIndex: -1,
                            display: isHovered || isScrubbing ? 'block' : 'none'
                        }} />

                        <motion.div 
                            animate={{ 
                                scale: isScrubbing ? 1.4 : isHovered ? 1.2 : 0,
                                opacity: isHovered || isScrubbing ? 1 : 0
                            }}
                            style={{
                                position: 'absolute', top: '50%', right: '-8px',
                                width: '16px', height: '16px', borderRadius: '50%',
                                background: 'white', marginTop: '-8px',
                                boxShadow: '0 0 20px rgba(0,0,0,0.6)',
                                border: '3px solid var(--bg-base)', zIndex: 10
                            }}
                        />
                    </div>
                </motion.div>
            </div>
            
            <div style={{ 
                display: 'flex', justifyContent: 'space-between', 
                marginTop: '4px', fontSize: '12px', 
                color: 'var(--text-tertiary)', fontWeight: 800,
                fontFamily: 'monospace', letterSpacing: '0.05em'
            }}>
                <motion.span animate={{ color: isScrubbing ? 'white' : 'var(--text-tertiary)' }}>
                    {formatTime(displayTime)}
                </motion.span>
                <span>{formatTime(duration)}</span>
            </div>
        </div>
    );
}

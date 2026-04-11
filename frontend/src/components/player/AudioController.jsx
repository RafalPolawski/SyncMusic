import React, { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useQueueStore } from '../../store/useQueueStore';
import { socket } from '../../lib/webtransport';

export default function AudioController() {
    const audioRef = useRef(null);
    const { 
        currentPath, 
        isPlaying, 
        volume, 
        syncReceivedTime, 
        syncAudioTime, 
        syncEnabled, 
        syncThreshold,
        setProgress
    } = usePlayerStore();
    const nextTrack = useQueueStore(state => state.nextTrack);

    // 1. Handle Track Switches
    useEffect(() => {
        if (!audioRef.current) return;
        const currentSrc = audioRef.current.src ? new URL(audioRef.current.src).pathname + new URL(audioRef.current.src).search : null;
        const targetSrc = currentPath ? `/api/stream?song=${encodeURIComponent(currentPath)}` : null;
        
        console.log('[AudioController] Path changed.', { currentPath, currentSrc, targetSrc });

        if (targetSrc && currentSrc !== targetSrc) {
            console.log('[AudioController] Loading new track:', targetSrc);
            audioRef.current.pause();
            audioRef.current.src = targetSrc;
            audioRef.current.load();
        } else if (!targetSrc) {
            audioRef.current.pause();
            audioRef.current.src = '';
        }
    }, [currentPath]);

    // 2. Handle Play/Pause and Seek Sync
    useEffect(() => {
        if (!audioRef.current || !currentPath) return;

        // Apply volume
        audioRef.current.volume = volume;

        if (isPlaying) {
            // Calculate target time based on server sync
            const now = Date.now();
            const elapsedSinceSync = (now - syncReceivedTime) / 1000;
            const targetTime = syncAudioTime + elapsedSinceSync;

            const drift = Math.abs(audioRef.current.currentTime - targetTime);

            // Hard seek if drift exceeds threshold, or just seeking after pause
            if (drift > syncThreshold && syncEnabled) {
                try {
                    audioRef.current.currentTime = targetTime;
                } catch (err) {
                    console.warn('[AudioController] Ignored currentTime seek on unready audio', err);
                }
            }

            // Deal with browser restrictions
            console.log('[AudioController] Playing audio at drift:', drift);
            audioRef.current.play().catch(e => console.warn("Auto-play blocked", e));
        } else {
            audioRef.current.pause();
            try {
                audioRef.current.currentTime = syncAudioTime;
            } catch (err) {}
        }
    }, [isPlaying, syncAudioTime, syncReceivedTime, syncEnabled, syncThreshold, currentPath, volume]);

    // 3. Time Update loop (for UI)
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const onTimeUpdate = () => {
            setProgress(audio.currentTime, audio.duration || 0);
        };
        const onEnded = () => {
            if (usePlayerStore.getState().isRepeat === 2) {
                audio.currentTime = 0;
                audio.play();
            } else {
                // Shift queue
                const next = nextTrack();
                if (next) {
                    // Send load to room or offline simulator
                    socket.sendCommand('load', { song: next.path, folder: next.folder });
                } else if (usePlayerStore.getState().isRepeat === 1) {
                    // repeat playlist? Not fully implemented, stop
                }
            }
        };

        // Unlock audio element on first interaction
        const unlockAudio = () => {
            if (audioRef.current && audioRef.current.src === '') {
                // Load empty blob to satisfy browser unlock without breaking currentSrc logic
                audioRef.current.src = 'data:audio/mp3;base64,//NgxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
                audioRef.current.play().then(() => {
                    audioRef.current.pause();
                    audioRef.current.src = currentPath ? `/api/stream?song=${encodeURIComponent(currentPath)}` : '';
                }).catch(() => {});
            }
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
        window.addEventListener('click', unlockAudio);
        window.addEventListener('touchstart', unlockAudio);

        return () => {
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('ended', onEnded);
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
    }, [setProgress, currentPath]);

    return <audio ref={audioRef} preload="auto" style={{ display: 'none' }} />;
}

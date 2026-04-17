import React, { useEffect, useRef } from 'react';
import { FastAverageColor } from 'fast-average-color';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useQueueStore } from '../../store/useQueueStore';
import { useCacheStore } from '../../store/useCacheStore';
import { socket } from '../../lib/webtransport';
import { playNext, playPrev } from '../../lib/playerActions';

export default function AudioController() {
    const audioRef = useRef(null);
    const { 
        title, artist, coverUrl,
        currentPath, 
        currentFolder,
        isPlaying, 
        volume, 
        syncReceivedTime, 
        syncAudioTime, 
        syncEnabled, 
        syncThreshold,
        setProgress,
        setDrift
    } = usePlayerStore();
    const nextTrack = useQueueStore(state => state.nextTrack);
    const { cacheSongs, cachedPaths } = useCacheStore();

    const lastCoverUrl = useRef(null);
    const lastColor = useRef({ hex: '#1DB954', rbg: '29,185,84' });

    // Theming (Symfonium Style) - Optimized with cache
    useEffect(() => {
        if (!coverUrl || coverUrl === lastCoverUrl.current) return;
        lastCoverUrl.current = coverUrl;

        const fac = new FastAverageColor();
        fac.getColorAsync(coverUrl)
            .then(color => {
                const rgb = color.value.slice(0,3).join(',');
                document.documentElement.style.setProperty('--dominant-color', color.hex);
                document.documentElement.style.setProperty('--dominant-color-rgb', rgb);
                lastColor.current = { hex: color.hex, rgb };
            })
            .catch(e => {
                console.warn('[Theming] Failed to extract color', e);
            });
    }, [coverUrl]);

    // Helper for path encoding
    const getAudioUrl = (path) => {
        if (!path) return '';
        return `/music/${path.split('/').map(encodeURIComponent).join('/')}`;
    };

    // Cleanup Audio on Unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.src = "";
            }
        };
    }, []);

    // 0. MediaSession Metadata & Controls
    useEffect(() => {
        if ('mediaSession' in navigator && currentPath) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title && title !== 'Select a Track' ? title : 'SyncMusic',
                artist: artist || 'Unknown Artist',
                artwork: [
                    { src: coverUrl || '/default-album.png', sizes: '512x512', type: 'image/png' }
                ]
            });
        }
    }, [title, artist, coverUrl, currentPath]);

    useEffect(() => {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => {
                usePlayerStore.setState({ isPlaying: true });
                socket.sendCommand('play', { time: usePlayerStore.getState().currentTime });
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                usePlayerStore.setState({ isPlaying: false });
                socket.sendCommand('pause', { time: usePlayerStore.getState().currentTime });
            });
            navigator.mediaSession.setActionHandler('nexttrack', () => {
                playNext();
            });
            navigator.mediaSession.setActionHandler('previoustrack', () => {
                playPrev();
            });
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.fastSeek && 'fastSeek' in audioRef.current) {
                    audioRef.current.fastSeek(details.seekTime);
                } else {
                    audioRef.current.currentTime = details.seekTime;
                }
                socket.sendCommand('seek', { time: details.seekTime });
            });
        }
    }, [nextTrack]);

    // 1. Handle Track Switches
    useEffect(() => {
        if (!audioRef.current) return;
        const currentSrc = audioRef.current.src ? new URL(audioRef.current.src).pathname + new URL(audioRef.current.src).search : null;
        const targetSrc = currentPath ? getAudioUrl(currentPath) : null;
        
        console.log('[AudioController] Path changed.', { currentPath, currentSrc, targetSrc });

        if (targetSrc && currentSrc !== targetSrc) {
            console.log('[AudioController] Loading new track:', targetSrc);
            audioRef.current.pause();
            audioRef.current.src = targetSrc;
            audioRef.current.load();

            // Standard browser preloading/buffering is handled by the <audio> tag.
            // Aggressive auto-cache is removed to prevent saturating bandwidth on slow networks.
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
            const hasValidSync = syncReceivedTime > 0;
            const elapsedSinceSync = hasValidSync ? (now - syncReceivedTime) / 1000 : 0;
            const targetTime = hasValidSync ? (syncAudioTime + elapsedSinceSync) : audioRef.current.currentTime;
            
            const drift = audioRef.current.currentTime - targetTime;
            if (hasValidSync) {
                setDrift(Math.round(Math.abs(drift) * 1000));
            }

            // Hard seek if drift exceeds threshold, or just seeking after pause
            if (hasValidSync && Math.abs(drift) > syncThreshold && syncEnabled) {
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
            const time = audio.currentTime;
            const dur = audio.duration || 0;
            setProgress(time, dur);
            
            if ('mediaSession' in navigator && !isNaN(dur) && dur > 0) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: dur,
                        playbackRate: audio.playbackRate,
                        position: time
                    });
                } catch (e) {
                    // Browser throws if position is negative or out of bounds occasionally.
                }
            }
        };
        const onEnded = () => {
            if (usePlayerStore.getState().isRepeat === 2) {
                audio.currentTime = 0;
                audio.play();
            } else {
                playNext();
            }
        };

        // Unlock audio element on first interaction
        const unlockAudio = () => {
            if (audioRef.current && (audioRef.current.src === '' || audioRef.current.src === window.location.href)) {
                audioRef.current.src = 'data:audio/mp3;base64,//NgxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
                audioRef.current.play().then(() => {
                    audioRef.current.pause();
                    audioRef.current.src = currentPath ? getAudioUrl(currentPath) : '';
                }).catch(() => {});
            }
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
        window.addEventListener('click', unlockAudio);
        window.addEventListener('touchstart', unlockAudio);

        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('ended', onEnded);

        return () => {
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('ended', onEnded);
            window.removeEventListener('click', unlockAudio);
            window.removeEventListener('touchstart', unlockAudio);
        };
    }, [setProgress, currentPath]);

    return <audio ref={audioRef} preload="auto" style={{ display: 'none' }} />;
}

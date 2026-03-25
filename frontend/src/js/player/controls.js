/**
 * Player controls: play/pause, progress bar, volume, shuffle/repeat, audio event listeners.
 */

import { Icons, Utils } from '../ui.js';

const svgVolume = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const svgVolumeMute = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';

export function initControls(audio, dom, state, socket, { updatePositionState, updateShuffleUI, updateRepeatUI, forcePlay, playNext, playPrev }) {
    const {
        playPauseBtn, miniPlayPauseBtn,
        progressBar, currentTimeDisp, durationDisp,
        coverArt, volumeSlider, volumeIcon,
        shuffleBtn, miniShuffleBtn,
        miniNextBtn, miniPrevBtn,
    } = dom;

    // Restore saved volume
    const savedVolume = parseFloat(localStorage.getItem('syncMusicVolume') ?? '1');
    audio.volume = savedVolume;
    volumeSlider.value = savedVolume;

    // ── Audio element events ──────────────────────────────────────────────────

    audio.addEventListener('timeupdate', () => {
        if (!state.isDraggingProgress) progressBar.value = audio.currentTime;
        currentTimeDisp.innerText = Utils.formatTime(audio.currentTime);
        if (audio.duration) {
            progressBar.max = audio.duration;
            durationDisp.innerText = Utils.formatTime(audio.duration);
        }
    });

    audio.addEventListener('loadedmetadata', () => {
        progressBar.max = audio.duration;
        durationDisp.innerText = Utils.formatTime(audio.duration);
        updatePositionState();
    });

    audio.addEventListener('seeked', updatePositionState);
    audio.addEventListener('ratechange', updatePositionState);

    audio.onplay = () => {
        playPauseBtn.innerHTML = Icons.pause;
        miniPlayPauseBtn.innerHTML = Icons.pause;
        coverArt.classList.add('playing');
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updatePositionState();
    };

    audio.onpause = () => {
        if (!state.shouldBePlaying) {
            playPauseBtn.innerHTML = Icons.play;
            miniPlayPauseBtn.innerHTML = Icons.play;
            coverArt.classList.remove('playing');
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
            updatePositionState();
        }
    };

    audio.addEventListener('canplay', () => {
        if (state.shouldBePlaying) forcePlay();
    });

    audio.onended = () => playNext(true);

    // Keep-alive watchdog: re-triggers play if audio stalls while it should be playing
    setInterval(() => {
        if (!state.hasJoined || !state.shouldBePlaying) return;
        if (audio.readyState < 3) return;
        const isActuallyMoving = audio.currentTime > state.lastKnownTime;
        state.lastKnownTime = audio.currentTime;
        if (audio.paused || !isActuallyMoving) forcePlay();
    }, 800);

    // ── Play / Pause ──────────────────────────────────────────────────────────

    const togglePlayPause = () => {
        if (navigator.vibrate) navigator.vibrate(50);
        if (audio.paused) {
            state.shouldBePlaying = true;
            audio.play().catch(e => console.log('Play blocked:', e));
            socket.sendCommand('play', { time: audio.currentTime });
        } else {
            state.shouldBePlaying = false;
            audio.pause();
            socket.sendCommand('pause', { time: audio.currentTime });
        }
    };

    playPauseBtn.onclick = togglePlayPause;
    miniPlayPauseBtn.onclick = togglePlayPause;

    // ── Progress bar ──────────────────────────────────────────────────────────

    progressBar.addEventListener('input', () => {
        state.isDraggingProgress = true;
        currentTimeDisp.innerText = Utils.formatTime(progressBar.value);
    });

    progressBar.addEventListener('change', () => {
        state.isDraggingProgress = false;
        if (navigator.vibrate) navigator.vibrate(20);
        socket.sendCommand('seek', { time: parseFloat(progressBar.value), isPlaying: state.shouldBePlaying });
    });

    // ── Volume ────────────────────────────────────────────────────────────────

    const updateVolumeIcon = () => {
        if (!volumeIcon) return;
        volumeIcon.innerHTML = (state.isMuted || audio.volume === 0) ? svgVolumeMute : svgVolume;
    };

    if (volumeIcon) {
        volumeIcon.style.cursor = 'pointer';
        volumeIcon.onclick = () => {
            if (navigator.vibrate) navigator.vibrate(30);
            if (state.isMuted) {
                state.isMuted = false;
                audio.volume = state.volumeBeforeMute;
                volumeSlider.value = state.volumeBeforeMute;
                socket.sendCommand('volume', { level: state.volumeBeforeMute });
            } else {
                state.isMuted = true;
                state.volumeBeforeMute = audio.volume || 1;
                audio.volume = 0;
                volumeSlider.value = 0;
                socket.sendCommand('volume', { level: 0 });
            }
            updateVolumeIcon();
        };
    }

    volumeSlider.addEventListener('input', () => {
        state.isMuted = false;
        audio.volume = volumeSlider.value;
        localStorage.setItem('syncMusicVolume', volumeSlider.value);
        socket.sendCommand('volume', { level: parseFloat(volumeSlider.value) });
        updateVolumeIcon();
    });

    // ── Shuffle / Repeat ──────────────────────────────────────────────────────

    const toggleShuffle = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand('shuffle', { state: !state.isShuffle });
    };

    const toggleRepeat = () => {
        if (navigator.vibrate) navigator.vibrate(30);
        socket.sendCommand('repeat', { state: (state.isRepeat + 1) % 3 });
    };

    shuffleBtn.onclick = toggleShuffle;
    miniShuffleBtn.onclick = toggleShuffle;
    document.getElementById('repeatBtn').onclick = toggleRepeat;
    dom.miniRepeatBtn.onclick = toggleRepeat;

    // ── Next / Prev ───────────────────────────────────────────────────────────

    document.getElementById('nextBtn').onclick = () => playNext(false);
    miniNextBtn.onclick = () => playNext(false);
    document.getElementById('prevBtn').onclick = playPrev;
    miniPrevBtn.onclick = playPrev;

    return { updateVolumeIcon };
}

export function updateShuffleUI(state, dom) {
    const { shuffleBtn, miniShuffleBtn } = dom;
    shuffleBtn.classList.toggle('active-green', state.isShuffle);
    miniShuffleBtn.classList.toggle('active-green', state.isShuffle);
}

export function updateRepeatUI(state, dom) {
    const { miniRepeatBtn } = dom;
    const btn = document.getElementById('repeatBtn');
    btn.classList.toggle('active-green', state.isRepeat > 0);
    miniRepeatBtn.classList.toggle('active-green', state.isRepeat > 0);

    const repeatIconHtml = state.isRepeat === 2
        ? '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';

    btn.innerHTML = repeatIconHtml;
    miniRepeatBtn.innerHTML = repeatIconHtml;
}

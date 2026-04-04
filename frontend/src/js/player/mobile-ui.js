/**
 * Mobile player expand/collapse UI.
 * Handles: mini-player click-to-expand, chevron collapse, pull-down gesture,
 * browser back-button integration, and swipe left/right for next/prev.
 */

export function initMobileUI(dom, navigation = {}) {
    const { playerContainer, miniPlayerClickZone, playerToggleBtn, progressBar } = dom;
    const { playNext, playPrev } = navigation;
    let isExpanded = false;

    const collapsePlayer = () => {
        if (isExpanded) {
            isExpanded = false;
            playerContainer.classList.remove('player-expanded');
        }
    };

    const expandPlayer = () => {
        if (!isExpanded && window.innerWidth < 1024) {
            isExpanded = true;
            playerContainer.classList.add('player-expanded');
            history.pushState({ playerOpen: true }, '');
        }
    };

    miniPlayerClickZone.onclick = (e) => {
        if (e.target.closest('#miniControls')) return;
        expandPlayer();
    };

    playerToggleBtn.onclick = (e) => {
        e.stopPropagation();
        if (isExpanded) history.back();
    };

    window.addEventListener('popstate', () => collapsePlayer());

    // ── Pull-down-to-close gesture ────────────────────────────────────────────
    let touchStartY = 0;
    let touchStartX = 0;

    playerContainer.addEventListener('touchstart', (e) => {
        touchStartY = e.changedTouches[0].screenY;
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    playerContainer.addEventListener('touchend', (e) => {
        const dy = e.changedTouches[0].screenY - touchStartY;
        const dx = e.changedTouches[0].screenX - touchStartX;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (isExpanded) {
            // Pull-down closes the expanded player
            if (e.target !== progressBar && dy > 80 && absDy > absDx) {
                history.back();
            }
            return;
        }

        // Mini-player swipe left = next, swipe right = prev
        if (absDx > 50 && absDx > absDy * 1.5) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (dx < 0 && playNext) playNext(false);
            else if (dx > 0 && playPrev) playPrev();
        }
    }, { passive: true });
}

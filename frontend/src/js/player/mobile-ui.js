/**
 * Mobile player expand/collapse UI.
 * Handles the mini-player click-to-expand, chevron collapse button,
 * pull-down gesture, and browser back-button integration.
 */

export function initMobileUI(dom) {
    const { playerContainer, miniPlayerClickZone, playerToggleBtn, progressBar } = dom;
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

    // Pull-down-to-close gesture
    let touchStartY = 0;
    playerContainer.addEventListener('touchstart', (e) => {
        touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    playerContainer.addEventListener('touchend', (e) => {
        if (!isExpanded) return;
        if (e.target === progressBar) return; // ignore drag on seekbar
        if (e.changedTouches[0].screenY - touchStartY > 80) {
            history.back();
        }
    }, { passive: true });
}

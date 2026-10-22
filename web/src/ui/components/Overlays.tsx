import { X } from 'lucide-react';
import { getEngine } from '../../engine';
import { useT } from '../../i18n';
import { useRoom, useUI } from '../../store/room';

/** Shown when the browser blocked autoplay: one tap unlocks audio. */
export function GestureOverlay() {
  const t = useT();
  const needs = useRoom((s) => s.player.needsGesture);
  if (!needs) return null;
  return (
    <button type="button" className="gesture-overlay" onClick={() => getEngine().resumeWithRoom()}>
      <span className="gesture-icon">▶</span>
      <strong>{t('tapToListen')}</strong>
      <small>{t('tapToListenHint')}</small>
    </button>
  );
}

export function Banners() {
  const t = useT();
  const halted = useRoom((s) => s.halted);
  const update = useUI((s) => s.updateAvailable);
  return (
    <>
      {halted === 'replaced' && (
        <div className="banner">
          <span>{t('replacedElsewhere')}</span>
          <button type="button" onClick={() => getEngine().takeOver()}>
            {t('takeOver')}
          </button>
        </div>
      )}
      {update && (
        <div className="banner">
          <span>{t('updateRequired')}</span>
          <button type="button" onClick={() => applyUpdate()}>
            {t('reload')}
          </button>
        </div>
      )}
    </>
  );
}

function applyUpdate(): void {
  const reg = navigator.serviceWorker?.getRegistration?.();
  if (!reg) {
    location.reload();
    return;
  }
  void reg.then((r) => {
    if (r?.waiting) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      r.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      location.reload();
    }
  });
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="close" onClick={() => dismiss(t.id)}>
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

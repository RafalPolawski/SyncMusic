import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getEngine } from './engine';
import { useUI } from './store/room';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Read-only diagnostics hook (used by the end-to-end tests).
(window as unknown as { __syncmusic: () => unknown }).__syncmusic = () => getEngine().debugInfo();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const announce = () => {
          if (reg.waiting && navigator.serviceWorker.controller) useUI.setState({ updateAvailable: true });
        };
        announce();
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', announce);
        });
        // Check for updates when the app comes back to the foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch((err: unknown) => console.warn('service worker registration failed', err));
  });
}

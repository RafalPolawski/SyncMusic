import { Library, ListMusic, Search, Settings } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { getEngine } from './engine';
import { useT } from './i18n';
import { useLibrary } from './store/library';
import { useRoom } from './store/room';
import { useSettings } from './store/settings';
import { MiniPlayer } from './ui/components/MiniPlayer';
import { NowPlaying } from './ui/components/NowPlaying';
import { Banners, GestureOverlay, Toasts } from './ui/components/Overlays';
import { ConnectionBadge } from './ui/components/Status';
import { installRouter, navigate, useRouter, type Route } from './ui/router';
import { AllTracksView, FolderView, PlaylistView } from './ui/views/CollectionViews';
import { LibraryView } from './ui/views/LibraryView';
import { LoginView } from './ui/views/LoginView';
import { QueueView } from './ui/views/QueueView';
import { SearchView } from './ui/views/SearchView';
import { SettingsView } from './ui/views/SettingsView';

type Phase =
  | { name: 'checking' }
  | { name: 'login'; needsPassword: boolean; unreachable: boolean; canOffline: boolean }
  | { name: 'app' };

/** Decides whether to show the login screen or the app. */
async function resolvePhase(): Promise<Phase> {
  const engine = getEngine();
  const named = !!useSettings.getState().name;
  const cached = await engine.db.getKV('library').catch(() => undefined);
  try {
    const s = await api.session();
    if ((s.authRequired && !s.authenticated) || !named) {
      return {
        name: 'login',
        needsPassword: s.authRequired && !s.authenticated,
        unreachable: false,
        canOffline: false,
      };
    }
    return { name: 'app' };
  } catch {
    // Server unreachable: keep working from the offline copy if there is one.
    if (named && cached) return { name: 'app' };
    return { name: 'login', needsPassword: false, unreachable: true, canOffline: !!cached };
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });

  const check = useCallback(() => {
    void resolvePhase().then(setPhase);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void resolvePhase().then((p) => {
      if (!cancelled) setPhase(p);
    });
    const uninstall = installRouter();
    return () => {
      cancelled = true;
      uninstall();
    };
  }, []);

  if (phase.name === 'checking') return <Splash />;
  if (phase.name === 'login') {
    return (
      <LoginView
        needsPassword={phase.needsPassword}
        unreachable={phase.unreachable}
        onDone={() => setPhase({ name: 'app' })}
        onOffline={
          phase.canOffline && useSettings.getState().name ? () => setPhase({ name: 'app' }) : undefined
        }
      />
    );
  }
  return (
    <Shell
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        getEngine().stop();
        setPhase({ name: 'login', needsPassword: true, unreachable: false, canOffline: false });
      }}
      onSessionLost={check}
    />
  );
}

function Splash() {
  return (
    <div className="splash">
      <img src="/icon-192.png" alt="" width={96} height={96} />
    </div>
  );
}

function Shell({ onLogout, onSessionLost }: { onLogout: () => void; onSessionLost: () => void }) {
  const route = useRouter((s) => s.route);
  const playerOpen = useRouter((s) => s.playerOpen);
  const status = useRoom((s) => s.status);
  const roomName = useRoom((s) => s.welcome?.room.name) ?? useSettings.getState().room;

  useEffect(() => {
    const engine = getEngine();
    void useLibrary.getState().load(engine.db);
    void engine.start();
  }, []);

  // A WebSocket refused because the session expired looks like a network
  // error; after a while of failing, ask the server whether we are logged in.
  useEffect(() => {
    if (status !== 'offline' || navigator.onLine === false) return;
    const id = setTimeout(() => {
      api
        .session()
        .then((s) => {
          if (s.authRequired && !s.authenticated) onSessionLost();
        })
        .catch(() => undefined);
    }, 8000);
    return () => clearTimeout(id);
  }, [status, onSessionLost]);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">{roomName}</span>
        <ConnectionBadge />
      </header>
      <Banners />
      <main className="content">
        <RouteView route={route} onLogout={onLogout} />
      </main>
      <MiniPlayer />
      <BottomNav route={route} />
      {playerOpen && <NowPlaying />}
      <GestureOverlay />
      <Toasts />
    </div>
  );
}

function RouteView({ route, onLogout }: { route: Route; onLogout: () => void }) {
  switch (route.name) {
    case 'folder':
      return <FolderView path={route.path} />;
    case 'playlist':
      return <PlaylistView id={route.id} />;
    case 'all':
      return <AllTracksView />;
    case 'search':
      return <SearchView />;
    case 'queue':
      return <QueueView />;
    case 'settings':
      return <SettingsView onLogout={onLogout} />;
    default:
      return <LibraryView />;
  }
}

function BottomNav({ route }: { route: Route }) {
  const t = useT();
  const inLibrary = ['library', 'folder', 'playlist', 'all'].includes(route.name);
  const items: { route: Route; label: string; icon: typeof Library; active: boolean }[] = [
    { route: { name: 'library' }, label: t('tabLibrary'), icon: Library, active: inLibrary },
    { route: { name: 'search' }, label: t('tabSearch'), icon: Search, active: route.name === 'search' },
    { route: { name: 'queue' }, label: t('tabQueue'), icon: ListMusic, active: route.name === 'queue' },
    {
      route: { name: 'settings' },
      label: t('tabSettings'),
      icon: Settings,
      active: route.name === 'settings',
    },
  ];
  return (
    <nav className="bottom-nav">
      {items.map(({ route: r, label, icon: Icon, active }) => (
        <button
          key={r.name}
          type="button"
          className={active ? 'is-active' : ''}
          aria-current={active ? 'page' : undefined}
          onClick={() => navigate(r)}
        >
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

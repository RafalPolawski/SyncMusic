// Minimal History API router: keeps the Android back button working and
// lets the player sheet be closed with "back".

import { create } from 'zustand';

export type Route =
  | { name: 'library' }
  | { name: 'folder'; path: string }
  | { name: 'playlist'; id: string }
  | { name: 'all' }
  | { name: 'search' }
  | { name: 'queue' }
  | { name: 'settings' };

interface RouterState {
  route: Route;
  playerOpen: boolean;
}

export function parse(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'folder':
      return { name: 'folder', path: decodeURIComponent(parts.slice(1).join('/')) };
    case 'playlist':
      return parts[1] ? { name: 'playlist', id: decodeURIComponent(parts[1]) } : { name: 'library' };
    case 'all':
      return { name: 'all' };
    case 'search':
      return { name: 'search' };
    case 'queue':
      return { name: 'queue' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'library' };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'folder':
      return '/folder/' + r.path.split('/').map(encodeURIComponent).join('/');
    case 'playlist':
      return '/playlist/' + encodeURIComponent(r.id);
    case 'library':
      return '/';
    default:
      return '/' + r.name;
  }
}

export const useRouter = create<RouterState>(() => ({
  route: typeof location === 'undefined' ? { name: 'library' } : parse(location.pathname),
  playerOpen: false,
}));

export function navigate(r: Route, replace = false): void {
  const url = href(r);
  if (replace) history.replaceState({}, '', url);
  else if (location.pathname !== url) history.pushState({}, '', url);
  useRouter.setState({ route: r, playerOpen: false });
  window.scrollTo?.({ top: 0 });
}

export function openPlayer(): void {
  history.pushState({ player: true }, '', location.pathname);
  useRouter.setState({ playerOpen: true });
}

export function closePlayer(): void {
  if ((history.state as { player?: boolean } | null)?.player) history.back();
  else useRouter.setState({ playerOpen: false });
}

export function installRouter(): () => void {
  const onPop = (e: PopStateEvent) => {
    const player = (e.state as { player?: boolean } | null)?.player === true;
    useRouter.setState({ route: parse(location.pathname), playerOpen: player });
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

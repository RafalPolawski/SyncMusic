import { afterEach, describe, expect, it } from 'vitest';
import {
  closePlayer,
  href,
  installRouter,
  navigate,
  openPlayer,
  parse,
  useRouter,
  type Route,
} from './router';

describe('router paths', () => {
  it.each<[string, Route]>([
    ['/', { name: 'library' }],
    ['/unknown/thing', { name: 'library' }],
    ['/folder/Chill/Wiecz%C3%B3r', { name: 'folder', path: 'Chill/Wieczór' }],
    ['/folder/', { name: 'folder', path: '' }],
    ['/playlist/p%201', { name: 'playlist', id: 'p 1' }],
    ['/playlist', { name: 'library' }],
    ['/all', { name: 'all' }],
    ['/search', { name: 'search' }],
    ['/queue', { name: 'queue' }],
    ['/settings', { name: 'settings' }],
  ])('parses %s', (path, route) => {
    expect(parse(path)).toEqual(route);
  });

  it.each<Route>([
    { name: 'library' },
    { name: 'folder', path: 'Siłownia/Nogi & Pośladki' },
    { name: 'folder', path: '' },
    { name: 'playlist', id: 'a/b?c' },
    { name: 'queue' },
    { name: 'settings' },
  ])('round-trips %j', (route) => {
    expect(parse(href(route))).toEqual(route);
  });
});

describe('navigation', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    history.replaceState(null, '', '/');
    useRouter.setState({ route: { name: 'library' }, playerOpen: false });
  });

  it('pushes history entries and follows the back button', async () => {
    uninstall = installRouter();
    navigate({ name: 'folder', path: 'Siłownia' });
    expect(location.pathname).toBe('/folder/Si%C5%82ownia');
    expect(useRouter.getState().route).toEqual({ name: 'folder', path: 'Siłownia' });

    navigate({ name: 'search' });
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    history.back();
    await popped;
    expect(useRouter.getState().route).toEqual({ name: 'folder', path: 'Siłownia' });
  });

  it('replaces the entry when asked', () => {
    const before = history.length;
    navigate({ name: 'queue' }, true);
    expect(history.length).toBe(before);
    expect(location.pathname).toBe('/queue');
  });

  it('closes the player with the back button', async () => {
    uninstall = installRouter();
    openPlayer();
    expect(useRouter.getState().playerOpen).toBe(true);
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    closePlayer();
    await popped;
    expect(useRouter.getState().playerOpen).toBe(false);
  });

  it('closes a player that has no history entry directly', () => {
    useRouter.setState({ playerOpen: true });
    closePlayer();
    expect(useRouter.getState().playerOpen).toBe(false);
  });
});

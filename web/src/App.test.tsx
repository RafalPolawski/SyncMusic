import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { en } from './i18n/en';
import { useLibrary } from './store/library';
import { useSettings } from './store/settings';
import { createHarness, disposeHarness, mockFetch, sampleLibrary, type Harness } from './test/harness';
import { useRouter } from './ui/router';

let h: Harness | undefined;

const session = (authRequired: boolean, authenticated: boolean) => ({
  json: { authRequired, authenticated, serverVersion: 'test', transcoding: true },
});

beforeEach(async () => {
  h = await createHarness();
  useSettings.setState({ language: 'en' });
  useLibrary.setState({ index: undefined, etag: '' });
});

afterEach(() => {
  disposeHarness(h);
  h = undefined;
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
  useRouter.setState({ route: { name: 'library' }, playerOpen: false });
});

describe('App', () => {
  it('asks for the password first', async () => {
    mockFetch({ '/api/session': session(true, false) });
    render(<App />);
    expect(await screen.findByLabelText(en.password)).toBeInTheDocument();
  });

  it('asks for a name on the first visit', async () => {
    useSettings.setState({ name: '' });
    mockFetch({ '/api/session': session(false, false) });
    render(<App />);
    expect(await screen.findByLabelText(en.yourName)).toBeInTheDocument();
    expect(screen.queryByLabelText(en.password)).toBeNull();
  });

  it('opens the library, connects and navigates between tabs', async () => {
    mockFetch({
      '/api/session': session(true, true),
      '/api/library': { json: sampleLibrary, headers: { ETag: '"lib-1"' } },
      '/api/rooms': { json: [] },
    });
    render(<App />);
    expect(await screen.findByText('Siłownia')).toBeInTheDocument();
    expect(screen.getByText('gym')).toBeInTheDocument();
    act(() => h!.connect());
    expect(await screen.findByText('Gym')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: en.tabSearch }));
    expect(screen.getByPlaceholderText(en.searchPlaceholder)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.tabSettings }));
    expect(screen.getByRole('button', { name: en.tabSettings })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: en.tabQueue }));
    expect(screen.getByText(en.queueEmpty)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.tabLibrary }));
    await userEvent.click(screen.getByText('Siłownia'));
    expect(screen.getByRole('heading', { name: 'Siłownia' })).toBeInTheDocument();
  });

  it('logs out back to the login screen', async () => {
    let loggedOut = false;
    mockFetch({
      '/api/session': session(true, true),
      '/api/library': { json: sampleLibrary },
      '/api/rooms': { json: [] },
      '/api/auth/logout': () => {
        loggedOut = true;
        return { status: 204 };
      },
    });
    history.replaceState(null, '', '/settings');
    useRouter.setState({ route: { name: 'settings' } });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: en.logout }));
    expect(await screen.findByLabelText(en.password)).toBeInTheDocument();
    expect(loggedOut).toBe(true);
  });

  it('keeps working offline from the cached library', async () => {
    await h!.engine.db.setKV('library', { etag: '"lib-1"', data: sampleLibrary });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    render(<App />);
    expect(await screen.findByText('Siłownia')).toBeInTheDocument();
  });

  it('explains when the server cannot be reached and nothing is cached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(en.serverUnreachable);
    expect(screen.queryByRole('button', { name: en.continueOffline })).toBeNull();
  });
});

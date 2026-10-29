import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../i18n/en';
import { pl } from '../../i18n/pl';
import { buildIndex, useLibrary } from '../../store/library';
import { useRoom, useUI } from '../../store/room';
import { useSettings } from '../../store/settings';
import {
  createHarness,
  disposeHarness,
  mockFetch,
  sampleLibrary,
  stateMessage,
  type FakeSocket,
  type Harness,
} from '../../test/harness';
import { useRouter } from '../router';
import { AllTracksView, FolderView, PlaylistView } from './CollectionViews';
import { LibraryView } from './LibraryView';
import { LoginView } from './LoginView';
import { QueueView } from './QueueView';
import { SearchView } from './SearchView';
import { SettingsView } from './SettingsView';

let h: Harness | undefined;
let ws: FakeSocket;

const audio = { body: new Uint8Array(32).fill(3) };
const routes = {
  '/api/tracks/a/audio': audio,
  '/api/tracks/b/audio': audio,
  '/api/tracks/c/audio': audio,
  '/api/tracks/d/audio': audio,
  '/api/tracks/e/audio': audio,
  '/api/rooms': { json: [] },
};

beforeEach(async () => {
  mockFetch(routes);
  h = await createHarness();
  useSettings.setState({ language: 'en' });
  await h.engine.start();
  ws = h.connect();
});

afterEach(() => {
  disposeHarness(h);
  h = undefined;
  vi.unstubAllGlobals();
  useRouter.setState({ route: { name: 'library' }, playerOpen: false });
});

const commands = () => ws.commands();

function receive(msg: unknown) {
  act(() => ws.receive(msg));
}

describe('LibraryView', () => {
  it('lists folders, loose tracks and playlists', async () => {
    render(<LibraryView />);
    expect(screen.getByText(en.allTracks)).toBeInTheDocument();
    expect(screen.getByText('5 tracks')).toBeInTheDocument();
    const [chill, gym] = screen
      .getAllByRole('button', { name: /tracks$/ })
      .filter((b) => b.classList.contains('tile'));
    expect(chill).toHaveTextContent('Chill');
    expect(gym).toHaveTextContent('Siłownia3 tracks');
    expect(screen.getByText(en.looseTracks)).toBeInTheDocument();
    expect(screen.getByText('Bieganie')).toBeInTheDocument();

    await userEvent.click(gym!);
    expect(useRouter.getState().route).toEqual({ name: 'folder', path: 'Siłownia' });
    await userEvent.click(screen.getByText('Bieganie'));
    expect(useRouter.getState().route).toEqual({ name: 'playlist', id: 'p1' });
    await userEvent.click(screen.getByText(en.allTracks));
    expect(useRouter.getState().route).toEqual({ name: 'all' });
  });

  it('shows scan progress for an empty library and offers a rescan', async () => {
    const empty = { version: 'empty', tracks: [], folders: [], playlists: [] };
    useLibrary.setState({ index: buildIndex(empty) });
    let scanning = true;
    let rescans = 0;
    mockFetch({
      '/api/library/status': () => ({ json: { scanning, processed: 3, total: 10, tracks: 0 } }),
      '/api/library': { status: 304 },
      '/api/library/rescan': () => {
        rescans++;
        return { json: { scanning: true, processed: 0, total: 0, tracks: 0 } };
      },
    });
    render(<LibraryView />);
    expect(await screen.findByText('Scanning library… 3/10')).toBeInTheDocument();
    scanning = false;
    // The view polls once a second until the scan is over.
    const rescan = await screen.findByRole('button', { name: en.rescan }, { timeout: 3000 });
    expect(screen.getByText(en.emptyLibrary)).toBeInTheDocument();
    await userEvent.click(rescan);
    expect(rescans).toBe(1);
    expect(await screen.findByText('Scanning library… 0/0')).toBeInTheDocument();
  });

  it('marks downloaded folders', async () => {
    await h!.engine.downloader.pin('folder:Chill', [{ id: 'd', rev: 'rd' }]);
    const { container } = render(<LibraryView />);
    await vi.waitFor(() => expect(container.querySelector('.dot-ok')).not.toBeNull());
  });
});

describe('collection views', () => {
  it('plays a folder from the start, from a track or shuffled', async () => {
    render(<FolderView path="Siłownia" />);
    expect(screen.getByRole('heading', { name: 'Siłownia' })).toBeInTheDocument();
    const context = { kind: 'folder', id: 'Siłownia', name: 'Siłownia', tracks: ['a', 'b', 'c'] };

    await userEvent.click(screen.getByRole('button', { name: en.play }));
    expect(commands().at(-1)).toEqual({ op: 'playContext', context });

    await userEvent.click(screen.getByText('Przysiady'));
    expect(commands().at(-1)).toEqual({ op: 'playContext', context, startIndex: 1 });

    // Shuffle is switched on first, then the context starts.
    await userEvent.click(screen.getByRole('button', { name: en.shufflePlay }));
    expect(commands().at(-1)).toEqual({ op: 'shuffle', on: true });
    receive({ type: 'ack', id: ws.ofType('cmd').at(-1)!.id, ok: true, version: 2 });
    await vi.waitFor(() => expect(commands().at(-1)).toEqual({ op: 'playContext', context }));
  });

  it('turns shuffle off when playing in order', async () => {
    receive(stateMessage(1, { shuffle: true }));
    render(<FolderView path="Siłownia" />);
    await userEvent.click(screen.getByRole('button', { name: en.play }));
    expect(
      commands()
        .slice(-2)
        .map((c) => c?.op),
    ).toEqual(['shuffle', 'playContext']);
  });

  it('includes subfolders in the folder context', async () => {
    render(<FolderView path="Chill" />);
    expect(screen.getByText('Wieczór')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.play }));
    expect(commands().at(-1)).toMatchObject({ context: { tracks: ['d'] } });
    await userEvent.click(screen.getByText('Wieczór'));
    expect(useRouter.getState().route).toEqual({ name: 'folder', path: 'Chill/Wieczór' });
  });

  it('shows loose files under their own name', () => {
    render(<FolderView path="" />);
    expect(screen.getByRole('heading', { name: en.looseTracks })).toBeInTheDocument();
    expect(screen.getByText('Luźny kawałek')).toBeInTheDocument();
  });

  it('handles unknown folders and playlists', () => {
    render(<FolderView path="nope" />);
    render(<PlaylistView id="nope" />);
    expect(screen.getAllByText(en.noResults)).toHaveLength(2);
  });

  it('downloads a playlist for offline use and removes it again', async () => {
    render(<PlaylistView id="p1" />);
    expect(screen.getByText('Martwy ciąg')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: en.download });
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(toggle).toHaveTextContent(en.downloaded));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(h!.engine.downloader.isPinned('playlist:p1')).toBe(true);

    await userEvent.click(toggle);
    await vi.waitFor(() => expect(toggle).toHaveTextContent(en.download));
    expect(h!.engine.downloader.isPinned('playlist:p1')).toBe(false);
  });

  it('lists every track', () => {
    render(<AllTracksView />);
    expect(screen.getAllByRole('button', { name: '⋯' })).toHaveLength(5);
  });

  it('adds a track to the queue from its menu', async () => {
    render(<AllTracksView />);
    await userEvent.click(screen.getAllByRole('button', { name: '⋯' })[1]!);
    const sheet = screen.getByRole('dialog', { name: 'Przysiady' });
    await userEvent.click(within(sheet).getByText(en.playNext));
    expect(commands().at(-1)).toEqual({ op: 'queueAdd', trackIds: ['b'], next: true });
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: '⋯' })[2]!);
    await userEvent.click(screen.getByText(en.addToQueue));
    expect(commands().at(-1)).toEqual({ op: 'queueAdd', trackIds: ['c'], next: false });

    await userEvent.click(screen.getAllByRole('button', { name: '⋯' })[0]!);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks tracks that cannot play offline', async () => {
    await h!.engine.downloader.pin('track:a', [{ id: 'a', rev: 'ra' }]);
    await vi.waitFor(() => expect(h!.engine.downloader.isDownloaded('a')).toBe(true));
    act(() => ws.drop());
    render(<FolderView path="Siłownia" />);
    expect(screen.getByLabelText(en.downloaded)).toBeInTheDocument();
    expect(screen.getAllByLabelText(en.unavailableOffline)).toHaveLength(2);
  });
});

describe('SearchView', () => {
  it('finds tracks without diacritics and plays the results', async () => {
    render(<SearchView />);
    await userEvent.type(screen.getByPlaceholderText(en.searchPlaceholder), 'luzny');
    await userEvent.click(await screen.findByText('Luźny kawałek'));
    expect(commands().at(-1)).toEqual({
      op: 'playContext',
      context: { kind: 'search', id: 'luzny', name: '„luzny”', tracks: ['e'] },
      startIndex: 0,
    });

    await userEvent.clear(screen.getByPlaceholderText(en.searchPlaceholder));
    await userEvent.type(screen.getByPlaceholderText(en.searchPlaceholder), 'zzz');
    expect(await screen.findByText(en.noResults)).toBeInTheDocument();
  });
});

describe('QueueView', () => {
  const room = (version: number, extra: Parameters<typeof stateMessage>[1] = {}) =>
    stateMessage(version, {
      playback: { trackId: 'a', positionMs: 0, anchorMs: Date.now(), playing: false, durationMs: 200_000 },
      context: {
        kind: 'folder',
        id: 'Siłownia',
        name: 'Siłownia',
        tracks: ['a', 'b', 'c'],
        order: [0, 1, 2],
      },
      contextIndex: 0,
      queueVersion: 1,
      queue: [
        { id: 'q1', trackId: 'd', addedBy: 'Ola' },
        { id: 'q2', trackId: 'e' },
      ],
      ...extra,
    });

  beforeEach(() => {
    receive(room(2));
  });

  it('shows what plays now, the queue and the rest of the context', () => {
    render(<QueueView />);
    expect(screen.getByText('Rozgrzewka')).toBeInTheDocument();
    expect(screen.getByText('Soft Waves · added by Ola')).toBeInTheDocument();
    expect(screen.getByText('Next from: Siłownia')).toBeInTheDocument();
    expect(screen.getByText('Martwy ciąg')).toBeInTheDocument();
  });

  it('edits the queue', async () => {
    render(<QueueView />);
    const up = screen.getAllByRole('button', { name: en.moveUp });
    const down = screen.getAllByRole('button', { name: en.moveDown });
    expect(up[0]).toBeDisabled();
    expect(down[1]).toBeDisabled();
    await userEvent.click(down[0]!);
    await userEvent.click(up[1]!);
    await userEvent.click(screen.getAllByRole('button', { name: en.removeFromQueue })[1]!);
    await userEvent.click(screen.getByText('Noc'));
    await userEvent.click(screen.getByText('Przysiady'));
    await userEvent.click(screen.getByRole('button', { name: en.clearQueue }));
    expect(commands()).toEqual([
      { op: 'queueMove', entryId: 'q1', toIndex: 1 },
      { op: 'queueMove', entryId: 'q2', toIndex: 0 },
      { op: 'queueRemove', entryId: 'q2' },
      { op: 'playEntry', entryId: 'q1' },
      { op: 'jump', index: 1 },
      { op: 'queueClear' },
    ]);
  });

  it('wraps around with repeat all', () => {
    receive(
      room(3, {
        repeat: 'all',
        playback: { trackId: 'c', positionMs: 0, anchorMs: Date.now(), playing: false, durationMs: 150_000 },
        contextIndex: 2,
        queueVersion: 2,
        queue: [],
      }),
    );
    render(<QueueView />);
    expect(screen.getByText(en.queueEmpty)).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Rozgrzewka'),
      expect.stringContaining('Przysiady'),
      expect.stringContaining('Martwy ciąg'),
    ]);
  });
});

describe('LoginView', () => {
  it('logs in and saves the profile', async () => {
    mockFetch({ '/api/auth/login': { status: 204 } });
    const done = vi.fn();
    render(<LoginView needsPassword onDone={done} />);
    const name = screen.getByLabelText(en.yourName);
    await userEvent.clear(name);
    await userEvent.type(name, '  Kuba ');
    await userEvent.clear(screen.getByLabelText(en.room));
    await userEvent.type(screen.getByLabelText(en.password), 'secret');
    await userEvent.click(screen.getByRole('button', { name: en.join }));
    expect(done).toHaveBeenCalled();
    expect(useSettings.getState()).toMatchObject({ name: 'Kuba', room: 'main' });
  });

  it.each([
    [401, en.wrongPassword],
    [429, en.tooManyAttempts],
    [500, en.serverUnreachable],
  ])('explains a %i response', async (status, message) => {
    mockFetch({ '/api/auth/login': { status, json: {} } });
    const done = vi.fn();
    render(<LoginView needsPassword onDone={done} />);
    await userEvent.type(screen.getByLabelText(en.password), 'x');
    await userEvent.click(screen.getByRole('button', { name: en.join }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(done).not.toHaveBeenCalled();
  });

  it('offers to continue offline when the server is unreachable', async () => {
    const offline = vi.fn();
    render(<LoginView needsPassword={false} unreachable onDone={() => {}} onOffline={offline} />);
    expect(screen.getByRole('alert')).toHaveTextContent(en.serverUnreachable);
    expect(screen.queryByLabelText(en.password)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: en.continueOffline }));
    expect(offline).toHaveBeenCalled();
  });

  it('requires a name', async () => {
    useSettings.setState({ name: '' });
    render(<LoginView needsPassword={false} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: en.join })).toBeDisabled();
  });
});

describe('SettingsView', () => {
  it('changes audio settings and tells the server', async () => {
    receive(stateMessage(1, { waitForAll: false }));
    render(<SettingsView onLogout={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: en.qualityLow }));
    expect(useSettings.getState().quality).toBe('low');
    expect(ws.ofType('profile').at(-1)).toEqual({ type: 'profile', quality: 'low' });
    expect(screen.getByRole('radio', { name: en.qualityLow })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByRole('radio', { name: en.headsetRoom }));
    expect(useSettings.getState().headsetControls).toBe('room');

    await userEvent.click(screen.getByRole('checkbox'));
    expect(commands().at(-1)).toEqual({ op: 'waitForAll', on: true });
  });

  it('switches the interface language', async () => {
    render(<SettingsView onLogout={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Polski' }));
    expect(screen.getByRole('heading', { name: pl.audio })).toBeInTheDocument();
  });

  it('renames the listener and changes rooms', async () => {
    mockFetch({
      ...routes,
      '/api/rooms': { json: [{ id: 'bieg', name: 'Bieg', listeners: ['Ola', 'Kuba'], playing: true }] },
    });
    render(<SettingsView onLogout={() => {}} />);
    const name = screen.getByDisplayValue('Ala');
    await userEvent.clear(name);
    await userEvent.type(name, 'Alicja');
    await userEvent.tab();
    expect(useSettings.getState().name).toBe('Alicja');

    await userEvent.click(await screen.findByRole('button', { name: 'Bieg · 2' }));
    expect(useSettings.getState().room).toBe('Bieg');

    const room = screen.getByDisplayValue('Bieg');
    await userEvent.clear(room);
    await userEvent.type(room, 'Rower');
    await userEvent.click(screen.getByRole('button', { name: en.changeRoom }));
    expect(useSettings.getState().room).toBe('Rower');
  });

  it('rescans the library and logs out', async () => {
    let rescans = 0;
    mockFetch({
      ...routes,
      '/api/library/rescan': () => {
        rescans++;
        return { json: { scanning: true, processed: 0, total: 0, tracks: 5 } };
      },
    });
    const logout = vi.fn();
    render(<SettingsView onLogout={logout} />);
    await userEvent.click(screen.getByRole('button', { name: en.rescan }));
    await vi.waitFor(() => expect(useUI.getState().toasts.map((x) => x.text)).toContain(en.rescan + ' ✓'));
    expect(rescans).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: en.logout }));
    expect(logout).toHaveBeenCalled();
  });

  it('clears downloads after confirmation', async () => {
    await h!.engine.downloader.pin('track:a', [{ id: 'a', rev: 'ra' }]);
    await vi.waitFor(() => expect(h!.engine.downloader.isDownloaded('a')).toBe(true));
    vi.stubGlobal('confirm', () => true);
    render(<SettingsView onLogout={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: en.clearDownloads }));
    await vi.waitFor(() => expect(h!.engine.downloader.stats().tracks).toBe(0));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: en.clearDownloads })).toBeDisabled());
  });

  it('shows the server version', () => {
    useRoom.setState({ welcome: { ...useRoom.getState().welcome!, serverVersion: '9.9.9' } });
    render(<SettingsView onLogout={() => {}} />);
    expect(screen.getByText(/9\.9\.9/)).toBeInTheDocument();
  });
});

// Keep the sample library intact between tests that swap it.
afterEach(() => {
  useLibrary.setState({ index: buildIndex(sampleLibrary) });
});

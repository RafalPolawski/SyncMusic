import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../i18n/en';
import { initialPlayer, useRoom, useUI } from '../../store/room';
import { clientId, useSettings } from '../../store/settings';
import type { Member, Playback } from '../../sync/protocol';
import {
  createHarness,
  disposeHarness,
  mockFetch,
  stateMessage,
  type FakeSocket,
  type Harness,
} from '../../test/harness';
import { useRouter } from '../router';
import { Controls, PlayPauseButton } from './Controls';
import { Cover, gradientFor } from './Cover';
import { MiniPlayer } from './MiniPlayer';
import { NowPlaying } from './NowPlaying';
import { Banners, GestureOverlay, Toasts } from './Overlays';
import { ProgressBar } from './ProgressBar';
import { ConnectionBadge, Listeners, SyncLine } from './Status';

let h: Harness | undefined;
let ws: FakeSocket;

beforeEach(async () => {
  mockFetch({});
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

function play(p: Partial<Playback>, extra: Parameters<typeof stateMessage>[1] = {}, version = 1) {
  act(() =>
    ws.receive(
      stateMessage(version, {
        playback: {
          trackId: 'a',
          positionMs: 0,
          anchorMs: Date.now(),
          playing: false,
          durationMs: 200_000,
          ...p,
        },
        context: {
          kind: 'folder',
          id: 'Siłownia',
          name: 'Siłownia',
          tracks: ['a', 'b', 'c'],
          order: [0, 1, 2],
        },
        ...extra,
      }),
    ),
  );
}

function player(p: Partial<typeof initialPlayer>) {
  act(() => useRoom.setState({ player: { ...useRoom.getState().player, ...p } }));
}

const member = (m: Partial<Member>): Member => ({
  clientId: 'x',
  name: 'Ola',
  connected: true,
  ready: true,
  buffering: false,
  playing: true,
  lastSeen: 0,
  ...m,
});

describe('NowPlaying', () => {
  it('shows the current track and where it comes from', () => {
    play({ trackId: 'a', positionMs: 65_000 });
    render(<NowPlaying />);
    expect(screen.getByRole('heading', { name: 'Rozgrzewka' })).toBeInTheDocument();
    expect(screen.getByText('Bass Lab')).toBeInTheDocument();
    expect(screen.getByText('Siłownia')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '65');
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.getByText('3:20')).toBeInTheDocument();
  });

  it('says when nothing is playing', () => {
    render(<NowPlaying />);
    expect(screen.getByText(en.nothingPlaying)).toBeInTheDocument();
  });

  it('counts down an armed start', () => {
    play({ playing: true, anchorMs: Date.now() + 2500 });
    render(<NowPlaying />);
    expect(screen.getByText(/Starting in [23] s/)).toBeInTheDocument();
  });

  it('offers to rejoin the room after a personal pause', async () => {
    play({ playing: true, anchorMs: Date.now() - 1000 });
    act(() => h!.engine.player.setPersonalPause(true));
    render(<NowPlaying />);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(en.resumeWithRoom) }));
    expect(useRoom.getState().player.personalPause).toBe(false);
  });

  it('warns when the track cannot be played offline', () => {
    play({});
    player({ unavailable: true });
    render(<NowPlaying />);
    expect(screen.getByText(en.unavailableOffline)).toBeInTheDocument();
  });

  it('closes and opens the queue', async () => {
    play({});
    useRouter.setState({ playerOpen: true });
    render(<NowPlaying />);
    await userEvent.click(screen.getByRole('button', { name: en.tabQueue }));
    expect(useRouter.getState().playerOpen).toBe(false);
    await vi.waitFor(() => expect(useRouter.getState().route).toEqual({ name: 'queue' }));
  });
});

describe('Controls', () => {
  it('sends room commands', async () => {
    play({ playing: true, anchorMs: Date.now() - 1000 }, { repeat: 'all' });
    render(<Controls />);
    await userEvent.click(screen.getByRole('button', { name: en.next }));
    await userEvent.click(screen.getByRole('button', { name: en.previous }));
    await userEvent.click(screen.getByRole('button', { name: en.shuffle }));
    await userEvent.click(screen.getByRole('button', { name: en.repeatAll }));
    await userEvent.click(screen.getByRole('button', { name: en.pause }));
    expect(commands().map((c) => c?.op)).toEqual(['next', 'prev', 'shuffle', 'repeat', 'pause']);
    expect(commands()[2]).toEqual({ op: 'shuffle', on: true });
    expect(commands()[3]).toEqual({ op: 'repeat', mode: 'one' });
  });

  it('shows a spinner while the room plays but this phone buffers', () => {
    play({ playing: true, anchorMs: Date.now() - 1000 });
    player({ buffering: true });
    const { container } = render(<PlayPauseButton />);
    expect(container.querySelector('.spin')).not.toBeNull();
  });

  it('offers play during a personal pause', () => {
    play({ playing: true, anchorMs: Date.now() - 1000 });
    act(() => h!.engine.player.setPersonalPause(true));
    render(<PlayPauseButton />);
    expect(screen.getByRole('button', { name: en.play })).toBeInTheDocument();
  });
});

describe('MiniPlayer', () => {
  it('is hidden until something plays and opens the player', async () => {
    const { container } = render(<MiniPlayer />);
    expect(container).toBeEmptyDOMElement();
    play({ trackId: 'b' });
    await screen.findByText('Przysiady');
    await userEvent.click(screen.getByText('Przysiady'));
    expect(useRouter.getState().playerOpen).toBe(true);
  });

  it('opens the player from the keyboard and rejoins from a personal pause', async () => {
    play({ trackId: 'b', playing: true, anchorMs: Date.now() - 1000 });
    act(() => h!.engine.player.setPersonalPause(true));
    render(<MiniPlayer />);
    await userEvent.click(
      screen.getByRole('button', { name: `${en.personalPaused} · ${en.resumeWithRoom}` }),
    );
    expect(useRoom.getState().player.personalPause).toBe(false);
    expect(useRouter.getState().playerOpen).toBe(false);
    fireEvent.keyDown(screen.getAllByRole('button')[0]!, { key: 'Enter' });
    expect(useRouter.getState().playerOpen).toBe(true);
  });
});

describe('ProgressBar', () => {
  beforeEach(() => {
    play({ positionMs: 50_000 });
  });

  it('seeks with the keyboard', () => {
    render(<ProgressBar />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(commands().at(-1)).toEqual({ op: 'seek', positionMs: 60_000 });
    // Relative to the position after the first seek.
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    expect(commands().at(-1)).toEqual({ op: 'seek', positionMs: 50_000 });
  });

  it('previews while dragging and seeks on release', () => {
    render(<ProgressBar />);
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    slider.setPointerCapture = () => {};
    fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 150, pointerId: 1 });
    expect(slider).toHaveAttribute('aria-valuenow', '150');
    expect(commands()).toEqual([]);
    fireEvent.pointerUp(slider, { clientX: 150, pointerId: 1 });
    expect(commands().at(-1)).toEqual({ op: 'seek', positionMs: 150_000 });
  });

  it('cancels a drag', () => {
    render(<ProgressBar />);
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    slider.setPointerCapture = () => {};
    fireEvent.pointerDown(slider, { clientX: 10, pointerId: 1 });
    fireEvent.pointerCancel(slider, { pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 10, pointerId: 1 });
    expect(commands()).toEqual([]);
    expect(slider).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('overlays', () => {
  it('asks for a tap when the browser blocked audio', async () => {
    const { container } = render(<GestureOverlay />);
    expect(container).toBeEmptyDOMElement();
    player({ needsGesture: true });
    await userEvent.click(screen.getByRole('button', { name: new RegExp(en.tapToListen) }));
    await vi.waitFor(() => expect(useRoom.getState().player.needsGesture).toBe(false));
  });

  it('lets this tab take over from another one', async () => {
    act(() => ws.receive({ type: 'error', code: 'replaced', message: '' }));
    render(<Banners />);
    expect(screen.getByText(en.replacedElsewhere)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.takeOver }));
    expect(screen.queryByText(en.replacedElsewhere)).toBeNull();
    expect(h!.sockets).toHaveLength(2);
  });

  it('announces updates', () => {
    act(() => useUI.setState({ updateAvailable: true }));
    render(<Banners />);
    expect(screen.getByText(en.updateRequired)).toBeInTheDocument();
  });

  it('shows and dismisses toasts', async () => {
    render(<Toasts />);
    act(() => useUI.getState().toast('Hello'));
    expect(screen.getByText('Hello')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByText('Hello')).toBeNull();
  });
});

describe('status', () => {
  it('shows the connection state and the number of listeners', () => {
    act(() => useRoom.setState({ members: [member({}), member({ clientId: 'y', connected: false })] }));
    const { rerender } = render(<ConnectionBadge />);
    expect(screen.getByLabelText(en.statusOnline)).toHaveTextContent('1');
    act(() => ws.drop());
    rerender(<ConnectionBadge />);
    expect(screen.getByLabelText(en.statusOffline)).toBeInTheDocument();
  });

  it('summarises sync quality', () => {
    act(() => useRoom.setState({ clockAccuracyMs: 4.2, rttMs: 31 }));
    player({ driftMs: 8 });
    const { rerender } = render(<SyncLine />);
    expect(screen.getByText(/In sync · /)).toHaveTextContent(/4.*31/);
    player({ driftMs: 80 });
    rerender(<SyncLine />);
    expect(screen.getByText(/off by 80 ms/)).toBeInTheDocument();
    act(() => useRoom.setState({ waiting: ['Ola'] }));
    rerender(<SyncLine />);
    expect(screen.getByText('Waiting for: Ola')).toBeInTheDocument();
    act(() => {
      useRoom.setState({ waiting: [] });
      ws.drop();
    });
    rerender(<SyncLine />);
    expect(screen.getByText(en.statusOffline)).toBeInTheDocument();
  });

  it('lists listeners with their drift', () => {
    act(() =>
      useRoom.setState({
        members: [
          member({ clientId: clientId(), name: 'ala', driftMs: 12.4 }),
          member({ name: 'Ola', driftMs: -30 }),
          member({ clientId: 'z', name: 'Kuba', connected: false }),
          member({ clientId: 'w', name: 'Ewa', ready: false }),
        ],
      }),
    );
    const { container } = render(<Listeners />);
    expect(screen.getByText(`(${en.you})`)).toBeInTheDocument();
    expect(screen.getByText('+12 ms')).toBeInTheDocument();
    expect(screen.getByText('-30 ms')).toBeInTheDocument();
    expect(container.querySelector('.listener-away')).toHaveTextContent('Kuba');
    expect(container.querySelector('.listener-loading')).toHaveTextContent('Ewa');
  });
});

describe('Cover', () => {
  it('shows the cover image and falls back to a placeholder', () => {
    const { container } = render(<Cover trackId="a" size={512} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/tracks/a/cover?s=512&v=ra');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('R');
  });

  it('draws initials for tracks without art', () => {
    const { container } = render(<Cover trackId="b" label="Iron Pulse" />);
    expect(container).toHaveTextContent('IP');
    const { container: empty } = render(<Cover label="!!!" />);
    expect(empty).toHaveTextContent('♪');
  });

  it('derives a stable gradient from the name', () => {
    expect(gradientFor('Siłownia')).toBe(gradientFor('Siłownia'));
    expect(gradientFor('Siłownia')).not.toBe(gradientFor('Chill'));
  });
});

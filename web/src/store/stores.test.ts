import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBytes, formatTime } from '../ui/hooks';
import { useUI } from './room';
import { clientId, defaultSettings, useSettings } from './settings';

afterEach(() => {
  vi.useRealTimers();
  useSettings.setState({ ...defaultSettings });
  useUI.setState({ toasts: [] });
});

describe('settings', () => {
  it('persists updates', () => {
    useSettings.getState().update({ name: 'Ola', quality: 'low' });
    expect(useSettings.getState().name).toBe('Ola');
    expect(JSON.parse(localStorage.getItem('syncmusic.settings')!)).toMatchObject({
      name: 'Ola',
      quality: 'low',
    });
  });

  it('keeps a stable client id', () => {
    const id = clientId();
    expect(id).toMatch(/^[a-zA-Z0-9-]{8,}$/);
    expect(clientId()).toBe(id);
  });
});

describe('toasts', () => {
  it('drops duplicates, keeps the last three and expires', () => {
    vi.useFakeTimers();
    const ui = useUI.getState();
    ui.toast('a');
    ui.toast('b');
    ui.toast('a');
    expect(useUI.getState().toasts.map((t) => t.text)).toEqual(['b', 'a']);
    ui.toast('c');
    ui.toast('d');
    expect(useUI.getState().toasts.map((t) => t.text)).toEqual(['a', 'c', 'd']);
    useUI.getState().dismiss(useUI.getState().toasts[0]!.id);
    expect(useUI.getState().toasts.map((t) => t.text)).toEqual(['c', 'd']);
    vi.advanceTimersByTime(4000);
    expect(useUI.getState().toasts).toEqual([]);
  });
});

describe('formatting', () => {
  it.each([
    [0, '0:00'],
    [59_999, '0:59'],
    [61_000, '1:01'],
    [3_600_000 + 5 * 60_000 + 7000, '1:05:07'],
    [-5, '0:00'],
    [Number.NaN, '0:00'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatTime(ms)).toBe(text);
  });

  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [50 * 1024 * 1024, '50 MB'],
    [3.2 * 1024 ** 3, '3.2 GB'],
  ])('formats %d bytes as %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});

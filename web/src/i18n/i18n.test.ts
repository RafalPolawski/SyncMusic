import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../store/settings';
import { en } from './en';
import { detectLanguage, format, resolveLanguage, t } from './index';
import { pl } from './pl';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => {
  vi.unstubAllGlobals();
  useSettings.setState({ language: 'auto' });
});

describe('i18n', () => {
  it('has the same placeholders in every language', () => {
    for (const key of Object.keys(pl) as (keyof typeof pl)[]) {
      expect(en[key], key).toBeTruthy();
      expect(placeholders(en[key]), key).toEqual(placeholders(pl[key]));
    }
  });

  it('fills placeholders', () => {
    expect(format('en', 'downloading', { done: 2, total: 5 })).toMatch(/2.*5/);
    expect(format('pl', 'tracksCount', { n: 3 })).toContain('3');
  });

  it('detects Polish from any preferred language', () => {
    vi.stubGlobal('navigator', { languages: ['de-DE', 'pl-PL'], language: 'de-DE' });
    expect(detectLanguage()).toBe('pl');
    vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
    expect(detectLanguage()).toBe('en');
    expect(resolveLanguage('pl')).toBe('pl');
  });

  it('follows the language setting', () => {
    useSettings.setState({ language: 'pl' });
    expect(t('play')).toBe(pl.play);
    useSettings.setState({ language: 'en' });
    expect(t('play')).toBe(en.play);
  });
});

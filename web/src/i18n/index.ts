import { useSettings } from '../store/settings';
import { en } from './en';
import { pl, type Messages } from './pl';

export type { Messages };
export type Lang = 'pl' | 'en';

const dictionaries: Record<Lang, Messages> = { pl, en };

export function detectLanguage(): Lang {
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  return langs.some((l) => l?.toLowerCase().startsWith('pl')) ? 'pl' : 'en';
}

export function resolveLanguage(setting: 'auto' | Lang): Lang {
  return setting === 'auto' ? detectLanguage() : setting;
}

export type MessageKey = keyof Messages;

/** Formats a message, replacing {name} placeholders. */
export function format(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = dictionaries[lang][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** React hook returning a translate function for the current language. */
export function useT() {
  const lang = resolveLanguage(useSettings((s) => s.language));
  return (key: MessageKey, vars?: Record<string, string | number>) => format(lang, key, vars);
}

/** Non-React access (e.g. Media Session, toasts). */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return format(resolveLanguage(useSettings.getState().language), key, vars);
}

'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * i18n provider + hook. Vietnamese is the default (SPEC_LOCK ui_language=vi).
 * The chosen language is a per-viewer convenience stored in localStorage; it is
 * never authoritative state and reads are wrapped so a private window never
 * throws. Adding a language = add a catalog to `catalogs` and a `Locale` entry.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { vi, type Messages } from './vi';
import { en } from './en';

export type Locale = 'vi' | 'en';

const catalogs: Record<Locale, Messages> = { vi, en };
export const DEFAULT_LOCALE: Locale = 'vi';
const STORAGE_KEY = 'redai.locale';

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'vi' || raw === 'en') return raw;
  } catch {
    // Blocked storage (private window): fall back to the default.
  }
  return DEFAULT_LOCALE;
}

interface I18nValue {
  locale: Locale;
  t: Messages;
  setLocale: (l: Locale) => void;
  /** Interpolate `{name}` placeholders in a leaf string. */
  fmt: (template: string, vars: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? readStoredLocale());

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Ignore: language choice is best-effort per-viewer state.
    }
  }, []);

  const fmt = useCallback((template: string, vars: Record<string, string | number>) => {
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in vars ? String(vars[key]) : match,
    );
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: catalogs[locale], setLocale, fmt }),
    [locale, setLocale, fmt],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Theme provider. Dark is the default (SPEC_LOCK theme=dark). The choice is a
 * per-viewer convenience persisted in localStorage and reflected as
 * `data-theme` on <html>, matching the CSS token blocks in globals.css. A tiny
 * inline script in the root layout applies the stored theme before paint to
 * avoid a flash; this provider keeps React state in sync.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';
export const DEFAULT_THEME: Theme = 'dark';
const STORAGE_KEY = 'redai.theme';

interface ThemeValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
  } catch {
    // Blocked storage: default.
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  const apply = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', t);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Best-effort persistence.
    }
  }, []);

  const value: ThemeValue = {
    theme,
    setTheme: apply,
    toggle: () => apply(theme === 'dark' ? 'light' : 'dark'),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

/** Script string applied before paint (no external deps) to set the theme early. */
export const themeBootstrapScript = `
(function(){
  try {
    var t = window.localStorage.getItem('${STORAGE_KEY}');
    if (t !== 'dark' && t !== 'light') t = '${DEFAULT_THEME}';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', '${DEFAULT_THEME}');
  }
})();
`;

/**
 * @redai/ui — shared, framework-agnostic visual primitives.
 *
 * Deliberately React-free: it exports the canonical design tokens (the single
 * source of truth the web app renders as CSS variables) plus a few pure helpers
 * that are genuinely reused across the UI (URL sanitisation for rendered
 * Markdown, byte/severity formatting). Keeping it pure lets the web app, tests
 * and any future surface consume it without pulling a UI framework into the
 * package graph.
 */

/** Spacing scale — multiples of 4px (docs/03 §10). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Named colour tokens; concrete values live per-theme below. */
export interface ColorTokens {
  bg: string;
  bgElevated: string;
  bgInset: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  /** Primary accent (redAI). Used sparingly for the main action. */
  accent: string;
  accentText: string;
  /** Destructive actions differ by icon/label too, never colour alone. */
  danger: string;
  warning: string;
  success: string;
  info: string;
  focus: string;
}

export const darkTheme: ColorTokens = {
  bg: '#0f1115',
  bgElevated: '#171a21',
  bgInset: '#0b0d11',
  border: '#262b36',
  borderStrong: '#3a414f',
  text: '#e7eaf0',
  textMuted: '#a2abbd',
  textFaint: '#6b7385',
  accent: '#e5484d',
  accentText: '#ffffff',
  danger: '#ff6369',
  warning: '#f5a524',
  success: '#46a758',
  info: '#5b9dff',
  focus: '#5b9dff',
};

export const lightTheme: ColorTokens = {
  bg: '#ffffff',
  bgElevated: '#f6f7f9',
  bgInset: '#eef0f3',
  border: '#dfe3e9',
  borderStrong: '#c3c9d4',
  text: '#1a1d24',
  textMuted: '#565e6e',
  textFaint: '#8b93a3',
  accent: '#d5323a',
  accentText: '#ffffff',
  danger: '#c62a30',
  warning: '#b26a00',
  success: '#2f7d3c',
  info: '#2563c9',
  focus: '#2563c9',
};

/** Severity ordering for findings; higher sorts first. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
export function severityRank(sev: string): number {
  return SEVERITY_RANK[sev as Severity] ?? 0;
}

/**
 * Sanitise a URL for a rendered link/image. Only http(s), mailto and relative
 * URLs are allowed; `javascript:`, `data:` (except images handled elsewhere) and
 * any other scheme resolve to `null` so the caller drops the href (docs/03 §6).
 */
export function sanitizeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === '') return null;
  // Relative or anchor links are safe (no scheme).
  if (/^(\/|\.|#|\?)/.test(url)) return url;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!schemeMatch) return url; // schemeless, treat as relative
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
  return null;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export const UI_PACKAGE = '@redai/ui';

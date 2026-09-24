'use client';

/**
 * Honest loading / empty / error state components. Errors never collapse into an
 * empty state (docs/03 §4): a load failure shows the message + a Retry button, an
 * empty result shows the empty copy. Both are distinguishable to the user.
 */
import { useI18n } from '../i18n/index';
import { ApiError } from '../lib/api';

export function LoadingState({ label }: { label?: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="muted" role="status" aria-live="polite">
      {label ?? t.common.loading}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="card muted" role="note">
      {children}
    </div>
  );
}

/** Map an unknown error to a user-facing message (never leaks internals). */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || err.code;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="banner banner-error" role="alert">
      <div>{errorMessage(error, t.common.errorGeneric)}</div>
      {onRetry ? (
        <button className="btn" style={{ marginTop: 8 }} onClick={onRetry}>
          {t.common.retry}
        </button>
      ) : null}
    </div>
  );
}

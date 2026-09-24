'use client';

/**
 * Client-side owner session gate. It fetches `/api/v1/auth/session`; a 401 sends
 * the user to `/login` (preserving the intended path). While resolving it shows a
 * neutral loading screen so a protected page never flashes its contents to an
 * unauthenticated viewer. The resolved profile (incl. the CSRF token, held only in
 * memory) is exposed via `useSession`.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getSession } from '../lib/endpoints';
import { ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../i18n/index';
import type { SessionProfile } from '../lib/types';

const SessionContext = createContext<SessionProfile | null>(null);

export function useSession(): SessionProfile {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within an authenticated SessionProvider');
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const { data, error, loading } = useAsync<SessionProfile>(() => getSession(), []);

  if (loading) {
    return (
      <div className="auth-wrap">
        <div className="muted" role="status" aria-live="polite">
          {t.common.loading}
        </div>
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 401) {
      const next = encodeURIComponent(pathname || '/');
      router.replace(`/login?next=${next}`);
      return (
        <div className="auth-wrap">
          <div className="muted">{t.login.sessionExpired}</div>
        </div>
      );
    }
    // Non-auth failure (e.g. API unreachable): show it, do not pretend logged-in.
    return (
      <div className="auth-wrap">
        <div className="auth-card banner banner-error" role="alert">
          {t.home.connectionFailure}
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="auth-wrap" />;
  }

  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>;
}

'use client';

/**
 * Owner sign-in (docs/13 §2). Calls the real auth API. The browser attaches the
 * Origin header (checked server-side) and the API sets the session + CSRF cookies
 * on success. Error states are precise: invalid credentials (generic, never
 * enumerates the account), rate limited (with retry-after), forbidden origin.
 */
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '../../i18n/index';
import { login } from '../../lib/endpoints';
import { ApiError } from '../../lib/api';

function LoginForm(): JSX.Element {
  const { t, fmt } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get('next') || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      router.replace(nextPath.startsWith('/') ? nextPath : '/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError(t.login.invalidCredentials);
        else if (err.status === 429)
          setError(fmt(t.login.rateLimited, { seconds: err.retryAfterSeconds ?? 60 }));
        else if (err.code === 'FORBIDDEN_ORIGIN') setError(t.login.forbiddenOrigin);
        else setError(err.message || t.common.errorGeneric);
      } else {
        setError(t.home.connectionFailure);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card card stack" onSubmit={onSubmit} noValidate>
        <h1 style={{ margin: 0 }}>{t.login.title}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          {t.login.subtitle}
        </p>

        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.login.username}</span>
          <input
            className="input"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.login.password}</span>
          <input
            className="input"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || username === '' || password === ''}
        >
          {submitting ? t.login.submitting : t.login.submit}
        </button>

        <Link href="/setup" className="faint">
          {t.login.needSetup}
        </Link>
      </form>
    </div>
  );
}

export default function LoginPage(): JSX.Element {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<div className="auth-wrap" />}>
      <LoginForm />
    </Suspense>
  );
}

'use client';

/**
 * Setup screen (docs/13 §1). redAI has a single owner bootstrapped once via a
 * host CLI — there is no browser signup. This page explains that flow and lets
 * the owner probe the current session state.
 *
 * Note (spec ambiguity, see report): the API exposes no unauthenticated
 * "owner exists" endpoint, so the browser cannot distinguish "no owner yet" from
 * "not signed in". We therefore probe `/api/v1/auth/session`: a valid session
 * means setup is effectively complete; a 401 means "sign in after bootstrapping".
 */
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../i18n/index';
import { getSession } from '../../lib/endpoints';
import { ApiError } from '../../lib/api';

type Probe = { kind: 'idle' } | { kind: 'session'; username: string } | { kind: 'none' };

export default function SetupPage(): JSX.Element {
  const { t, fmt } = useI18n();
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' });
  const [checking, setChecking] = useState(false);

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      const profile = await getSession();
      setProbe({ kind: 'session', username: profile.username });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setProbe({ kind: 'none' });
      else setProbe({ kind: 'none' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card stack" style={{ maxWidth: 560 }}>
        <div className="card stack">
          <h1 style={{ margin: 0 }}>{t.setup.title}</h1>
          <p className="muted">{t.setup.intro}</p>
        </div>

        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 18 }}>{t.setup.cliHeading}</h2>
          <p className="muted">{t.setup.cliBody}</p>
          <pre className="mono" style={{ margin: 0 }}>
            <code>{t.setup.cliCommand}</code>
          </pre>
          <p className="faint" style={{ marginBottom: 0 }}>
            {t.setup.note}
          </p>
        </div>

        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 18 }}>{t.setup.checkHeading}</h2>
          <p className="muted">{t.setup.checkBody}</p>
          <button className="btn" onClick={check} disabled={checking}>
            {checking ? t.common.loading : t.setup.checkButton}
          </button>
          {probe.kind === 'session' ? (
            <div className="banner banner-info" role="status">
              {fmt(t.setup.hasSession, { username: probe.username })}
            </div>
          ) : null}
          {probe.kind === 'none' ? (
            <div className="banner banner-warn" role="status">
              {t.setup.noSession}
            </div>
          ) : null}
          <div className="row">
            {probe.kind === 'session' ? (
              <Link href="/" className="btn btn-primary">
                {t.setup.goToApp}
              </Link>
            ) : (
              <Link href="/login" className="btn">
                {t.setup.goToLogin}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

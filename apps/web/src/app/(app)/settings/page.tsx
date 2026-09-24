'use client';

/**
 * App settings (docs/13 §4). Three groups wired to the real API:
 *  - Appearance: theme + language (per-viewer, applied immediately) and the
 *    workspace timezone persisted via PUT /settings with optimistic concurrency.
 *  - Model providers (T05): list configs, add one with an inline API key (stored
 *    in the encrypted vault — the UI only ever sees masked metadata), toggle
 *    enabled, and revoke secrets. No raw secret is ever shown or sent to storage.
 *  - Security: current session info + server-side sign-out. Password change and
 *    session revocation are host-CLI operations in this version (stated honestly).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n, type Locale } from '../../../i18n/index';
import { useTheme } from '../../../theme/ThemeProvider';
import { useSession } from '../../../components/SessionProvider';
import {
  getSettings,
  updateSettings,
  listProviders,
  createProvider,
  updateProvider,
  listSecrets,
  revokeSecret,
  logout,
} from '../../../lib/endpoints';
import { ApiError } from '../../../lib/api';
import { useAsync } from '../../../lib/useAsync';
import { LoadingState, ErrorState } from '../../../components/states';
import type { ProviderConfig, SecretMetadata, WorkspaceSettings } from '../../../lib/types';

type Tab = 'appearance' | 'providers' | 'security';

export default function SettingsPage(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('appearance');

  return (
    <div className="content stack">
      <h1>{t.settings.title}</h1>
      <div className="workbench-tabs" role="tablist" style={{ padding: 0 }}>
        {(
          [
            ['appearance', t.settings.tabAppearance],
            ['providers', t.settings.tabProviders],
            ['security', t.settings.tabSecurity],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`workbench-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'appearance' ? <AppearanceTab /> : null}
      {tab === 'providers' ? <ProvidersTab /> : null}
      {tab === 'security' ? <SecurityTab /> : null}
    </div>
  );
}

function AppearanceTab(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const settings = useAsync<WorkspaceSettings>(() => getSettings(), []);

  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (settings.data) {
      const tz = settings.data.settings['timezone'];
      if (typeof tz === 'string') setTimezone(tz);
    }
  }, [settings.data]);

  const onSaveTimezone = async (): Promise<void> => {
    if (!settings.data) return;
    setSaving(true);
    setSaved(false);
    setConflict(false);
    try {
      await updateSettings(settings.data.revision, {
        ...settings.data.settings,
        timezone,
      });
      setSaved(true);
      settings.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card stack">
      <label className="stack" style={{ gap: 4 }}>
        <span>{t.settings.theme}</span>
        <select
          className="select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
        >
          <option value="dark">{t.settings.themeDark}</option>
          <option value="light">{t.settings.themeLight}</option>
        </select>
      </label>

      <label className="stack" style={{ gap: 4 }}>
        <span>{t.settings.language}</span>
        <select
          className="select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </label>

      <div className="section-title">{t.settings.timezone}</div>
      {settings.loading ? (
        <LoadingState />
      ) : settings.error ? (
        <ErrorState error={settings.error} onRetry={settings.reload} />
      ) : (
        <>
          <input
            className="input"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setSaved(false);
            }}
            aria-label={t.settings.timezone}
          />
          {conflict ? (
            <div className="banner banner-error" role="alert">
              {t.project.conflict}
            </div>
          ) : null}
          {saved ? (
            <div className="banner banner-info" role="status">
              {t.common.saved}
            </div>
          ) : null}
          <div className="row">
            <button className="btn btn-primary" onClick={onSaveTimezone} disabled={saving}>
              {saving ? t.common.saving : t.common.save}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProvidersTab(): JSX.Element {
  const { t } = useI18n();
  const providers = useAsync<{ items: ProviderConfig[] }>(() => listProviders(), []);
  const secrets = useAsync<{ items: SecretMetadata[] }>(() => listSecrets(), []);

  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const onAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (displayName.trim() === '') return;
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      await createProvider({
        display_name: displayName.trim(),
        config: {},
        ...(apiKey ? { api_key: apiKey } : {}),
      });
      setDisplayName('');
      setApiKey('');
      setSavedMsg(t.settings.secretSaved);
      providers.reload();
      secrets.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setError(t.settings.validationError);
      else setError(t.common.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (p: ProviderConfig): Promise<void> => {
    try {
      await updateProvider(p.id, p.revision, { enabled: !p.enabled });
      providers.reload();
    } catch {
      providers.reload();
    }
  };

  const onRevoke = async (id: string): Promise<void> => {
    try {
      await revokeSecret(id);
      secrets.reload();
      providers.reload();
    } catch {
      secrets.reload();
    }
  };

  return (
    <div className="stack">
      <form className="card stack" onSubmit={onAdd}>
        <div className="section-title">{t.settings.addProvider}</div>
        <label className="stack" style={{ gap: 4 }}>
          <span>{t.settings.displayName}</span>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span>
            {t.settings.apiKey} <span className="faint">({t.common.optional})</span>
          </span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="faint">{t.settings.apiKeyHint}</span>
        </label>
        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}
        {savedMsg ? (
          <div className="banner banner-info" role="status">
            {savedMsg}
          </div>
        ) : null}
        <div className="row">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || displayName.trim() === ''}
          >
            {busy ? t.common.saving : t.settings.addProvider}
          </button>
        </div>
      </form>

      <div className="section-title">{t.settings.providers}</div>
      {providers.loading ? (
        <LoadingState />
      ) : providers.error ? (
        <ErrorState error={providers.error} onRetry={providers.reload} />
      ) : providers.data && providers.data.items.length > 0 ? (
        providers.data.items.map((p) => (
          <div key={p.id} className="card stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{p.display_name}</strong>
              <span className="badge">
                {t.settings.probeStatus}: {p.probe_status}
              </span>
            </div>
            {p.credential ? (
              <div className="faint mono">
                {t.settings.credential}: {p.credential.name} · {p.credential.masked}
                {p.credential.revoked ? ` · ${t.settings.revoked}` : ''}
              </div>
            ) : null}
            <div className="row">
              <button className="btn" onClick={() => onToggle(p)}>
                {p.enabled ? t.settings.enabled : t.common.notImplemented}
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="card muted">{t.settings.noProviders}</div>
      )}

      <div className="section-title">{t.settings.secrets}</div>
      {secrets.loading ? (
        <LoadingState />
      ) : secrets.error ? (
        <ErrorState error={secrets.error} onRetry={secrets.reload} />
      ) : secrets.data && secrets.data.items.length > 0 ? (
        secrets.data.items.map((s) => (
          <div key={s.id} className="card row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div>
                <strong>{s.name}</strong> <span className="badge">{s.kind}</span>
              </div>
              <div className="faint">v{s.version}</div>
            </div>
            {s.revoked ? (
              <span className="badge">{t.settings.revoked}</span>
            ) : (
              <button className="btn btn-danger" onClick={() => onRevoke(s.id)}>
                {t.settings.revoke}
              </button>
            )}
          </div>
        ))
      ) : (
        <div className="card muted">{t.settings.noSecrets}</div>
      )}
    </div>
  );
}

function SecurityTab(): JSX.Element {
  const { t } = useI18n();
  const session = useSession();
  const router = useRouter();

  const onSignOut = async (): Promise<void> => {
    try {
      await logout();
    } catch {
      // Fall through to login regardless.
    }
    router.replace('/login');
  };

  return (
    <div className="card stack">
      <div className="section-title">{t.settings.security}</div>
      <p className="muted">{t.settings.securityBody}</p>
      <div className="stack" style={{ gap: 4 }}>
        <div className="section-title">{t.settings.sessionInfo}</div>
        <div>
          <strong>{session.username}</strong>
        </div>
        <div className="faint">
          {t.project.status}: {new Date(session.expires_at).toLocaleString()}
        </div>
      </div>
      <div className="row">
        <button className="btn btn-danger" onClick={onSignOut}>
          {t.settings.signOutEverywhere}
        </button>
      </div>
    </div>
  );
}

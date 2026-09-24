'use client';

/**
 * Home (`/`): recent projects + Inbox. New-project creation is wired to the real
 * API. Loading / empty / connection-failure states are distinct (docs/03 §9).
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '../../i18n/index';
import { listProjects, createProject } from '../../lib/endpoints';
import { useAsync } from '../../lib/useAsync';
import { LoadingState, ErrorState } from '../../components/states';
import type { Project } from '../../lib/types';

export default function HomePage(): JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const { data, error, loading, reload } = useAsync<{ items: Project[] }>(() => listProjects(), []);

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (name.trim() === '') return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ name: name.trim() });
      setName('');
      router.push(`/p/${project.id}`);
    } catch {
      setCreateError(t.common.errorGeneric);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="content stack">
      <h1>{t.home.title}</h1>

      <form className="card stack" onSubmit={onCreate}>
        <div className="section-title">{t.home.newProject}</div>
        <div className="row">
          <input
            className="input"
            placeholder={t.home.projectName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={t.home.projectName}
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={creating || name.trim() === ''}
          >
            {creating ? t.common.creating : t.common.create}
          </button>
        </div>
        {createError ? (
          <div className="field-error" role="alert">
            {createError}
          </div>
        ) : null}
        <p className="faint" style={{ margin: 0 }}>
          {t.home.inboxHint}
        </p>
      </form>

      <div className="section-title">{t.home.recentProjects}</div>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && data.items.length > 0 ? (
        <div className="stack">
          {data.items.map((p) => (
            <Link
              key={p.id}
              href={`/p/${p.id}`}
              className="card row"
              style={{ textDecoration: 'none' }}
            >
              <div style={{ flex: 1 }}>
                <div>
                  <strong>{p.is_inbox ? t.nav.inbox : p.name}</strong>{' '}
                  {p.status !== 'active' ? <span className="badge">{p.status}</span> : null}
                </div>
                {p.description ? <div className="muted">{p.description}</div> : null}
              </div>
              <span className="badge">{p.approval_mode}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card muted">{t.home.noProjects}</div>
      )}
    </div>
  );
}

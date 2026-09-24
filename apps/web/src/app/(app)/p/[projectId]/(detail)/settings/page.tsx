'use client';

/**
 * Project settings: scope (approval mode, data mode), name/description, and the
 * worker bindings list. Saving uses optimistic-concurrency (`expected_revision`);
 * a 409 surfaces an explicit conflict state (docs/03 §2 "dirty/conflict/saved").
 * Worker bindings are read-only here (Ask still works without one; docs/03 §9).
 */
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useI18n } from '../../../../../../i18n/index';
import { getProject, updateProject, listBindings } from '../../../../../../lib/endpoints';
import { ApiError } from '../../../../../../lib/api';
import { useAsync } from '../../../../../../lib/useAsync';
import { LoadingState, ErrorState } from '../../../../../../components/states';
import type { ApprovalMode, DataMode, Project, WorkerBinding } from '../../../../../../lib/types';

const APPROVAL_MODES: ApprovalMode[] = ['automatic', 'always_ask', 'ask_high_risk', 'reject'];
const DATA_MODES: DataMode[] = ['local_only', 'redacted_cloud', 'cloud_full'];

export default function ProjectSettingsPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const project = useAsync<Project>(() => getProject(projectId), [projectId]);
  const bindings = useAsync<{ items: WorkerBinding[] }>(() => listBindings(projectId), [projectId]);

  const [form, setForm] = useState<{
    name: string;
    description: string;
    approval_mode: ApprovalMode;
    data_mode: DataMode;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (project.data) {
      setForm({
        name: project.data.name,
        description: project.data.description ?? '',
        approval_mode: project.data.approval_mode,
        data_mode: project.data.data_mode,
      });
      setSaved(false);
      setConflict(false);
    }
  }, [project.data]);

  const dirty =
    !!project.data &&
    !!form &&
    (form.name !== project.data.name ||
      form.description !== (project.data.description ?? '') ||
      form.approval_mode !== project.data.approval_mode ||
      form.data_mode !== project.data.data_mode);

  const onSave = async (): Promise<void> => {
    if (!project.data || !form) return;
    setSaving(true);
    setSaved(false);
    setConflict(false);
    setSaveError(null);
    try {
      await updateProject(projectId, project.data.revision, {
        name: form.name,
        description: form.description,
        approval_mode: form.approval_mode,
        data_mode: form.data_mode,
      });
      setSaved(true);
      project.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else setSaveError(t.common.errorGeneric);
    } finally {
      setSaving(false);
    }
  };

  if (project.loading) {
    return (
      <div className="content">
        <LoadingState />
      </div>
    );
  }
  if (project.error) {
    return (
      <div className="content">
        <ErrorState error={project.error} onRetry={project.reload} />
      </div>
    );
  }
  if (!form) return <div className="content" />;

  return (
    <div className="content stack">
      <h1>{t.nav.projectSettings}</h1>

      {conflict ? (
        <div className="banner banner-error" role="alert">
          {t.project.conflict}
        </div>
      ) : null}
      {saveError ? (
        <div className="banner banner-error" role="alert">
          {saveError}
        </div>
      ) : null}
      {saved && !dirty ? (
        <div className="banner banner-info" role="status">
          {t.common.saved}
        </div>
      ) : null}
      {dirty ? (
        <div className="badge" role="status">
          {t.common.dirtyUnsaved}
        </div>
      ) : null}

      <div className="card stack">
        <div className="section-title">{t.project.scope}</div>

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.home.projectName}</span>
          <input
            className="input"
            value={form.name}
            disabled={project.data?.is_inbox}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.project.description}</span>
          <textarea
            className="textarea"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.project.approvalMode}</span>
          <select
            className="select"
            value={form.approval_mode}
            onChange={(e) => setForm({ ...form, approval_mode: e.target.value as ApprovalMode })}
          >
            {APPROVAL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span>{t.project.dataMode}</span>
          <select
            className="select"
            value={form.data_mode}
            onChange={(e) => setForm({ ...form, data_mode: e.target.value as DataMode })}
          >
            {DATA_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <button className="btn btn-primary" onClick={onSave} disabled={saving || !dirty}>
            {saving ? t.common.saving : t.common.save}
          </button>
        </div>
      </div>

      <div className="card stack">
        <div className="section-title">{t.project.workerBinding}</div>
        {bindings.loading ? (
          <LoadingState />
        ) : bindings.error ? (
          <ErrorState error={bindings.error} onRetry={bindings.reload} />
        ) : bindings.data && bindings.data.items.length > 0 ? (
          bindings.data.items.map((b) => (
            <div key={b.worker_id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono">{b.worker_id}</span>
              <span className="badge">{b.zone ?? '—'}</span>
              <span className="badge">{b.enabled ? t.settings.enabled : t.settings.revoked}</span>
            </div>
          ))
        ) : (
          <div className="muted">{t.project.noBindings}</div>
        )}
      </div>
    </div>
  );
}

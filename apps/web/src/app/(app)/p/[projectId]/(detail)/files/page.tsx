'use client';

/**
 * Project files & notes. Artifacts and notes are the real API lists. Upload is a
 * labelled shell that arrives with the Agent (T10b) — the existing artifacts are
 * genuine data, never fabricated. Logical filenames only; no host paths (docs/03 §7).
 */
import { useParams } from 'next/navigation';
import { useI18n } from '../../../../../../i18n/index';
import { formatBytes } from '@redai/ui';
import { listArtifacts, listNotes } from '../../../../../../lib/endpoints';
import { useAsync } from '../../../../../../lib/useAsync';
import { LoadingState, ErrorState } from '../../../../../../components/states';
import type { Artifact, Note } from '../../../../../../lib/types';

export default function ProjectFilesPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const artifacts = useAsync<{ items: Artifact[] }>(() => listArtifacts(projectId), [projectId]);
  const notes = useAsync<{ items: Note[] }>(() => listNotes(projectId), [projectId]);

  return (
    <div className="content stack">
      <h1>{t.files.title}</h1>
      <div className="banner banner-info" role="note">
        {t.files.uploadComing}
      </div>

      <div className="section-title">{t.files.artifacts}</div>
      {artifacts.loading ? (
        <LoadingState />
      ) : artifacts.error ? (
        <ErrorState error={artifacts.error} onRetry={artifacts.reload} />
      ) : artifacts.data && artifacts.data.items.length > 0 ? (
        <div className="stack">
          {artifacts.data.items.map((a) => (
            <div key={a.id} className="card row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {a.filename}
                </div>
                <div className="faint">{a.media_type}</div>
              </div>
              <span className="badge">
                {t.files.size}: {formatBytes(a.byte_size)}
              </span>
              <span className="badge">{a.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="card muted">{t.files.noArtifacts}</div>
      )}

      <div className="section-title">{t.files.notes}</div>
      {notes.loading ? (
        <LoadingState />
      ) : notes.error ? (
        <ErrorState error={notes.error} onRetry={notes.reload} />
      ) : notes.data && notes.data.items.length > 0 ? (
        <div className="stack">
          {notes.data.items.map((n) => (
            <div key={n.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{n.title}</strong>
                {n.selected_for_context ? (
                  <span className="badge">{t.files.selectedForContext}</span>
                ) : null}
              </div>
              <div className="muted" style={{ overflowWrap: 'anywhere' }}>
                {n.content}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card muted">{t.files.noNotes}</div>
      )}
    </div>
  );
}

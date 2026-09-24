'use client';

/**
 * Project overview: light metadata, recent chats and a findings placeholder.
 * Archived / not-found / error states are explicit (docs/03 §2). Findings are a
 * labelled empty shell — the findings list API lands with a later milestone, so
 * this never fabricates entries.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '../../../../../i18n/index';
import {
  getProject,
  listChats,
  createChat,
  archiveProject,
  unarchiveProject,
} from '../../../../../lib/endpoints';
import { ApiError } from '../../../../../lib/api';
import { useAsync } from '../../../../../lib/useAsync';
import { LoadingState, ErrorState } from '../../../../../components/states';
import type { Chat, Project } from '../../../../../lib/types';

export default function ProjectOverviewPage(): JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const project = useAsync<Project>(() => getProject(projectId), [projectId]);
  const chats = useAsync<{ items: Chat[] }>(() => listChats(projectId), [projectId]);
  const [busy, setBusy] = useState(false);

  const onNewChat = async (): Promise<void> => {
    setBusy(true);
    try {
      const chat = await createChat(projectId, {});
      router.push(`/p/${projectId}/c/${chat.id}`);
    } finally {
      setBusy(false);
    }
  };

  const onArchiveToggle = async (archived: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (archived) await unarchiveProject(projectId);
      else await archiveProject(projectId);
      project.reload();
    } finally {
      setBusy(false);
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
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <div className="content">
          <div className="banner banner-error" role="alert">
            {t.project.notFound}
          </div>
        </div>
      );
    }
    return (
      <div className="content">
        <ErrorState error={project.error} onRetry={project.reload} />
      </div>
    );
  }

  const p = project.data;
  if (!p) return <div className="content" />;
  const archived = p.status === 'archived';

  return (
    <div className="content stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{p.is_inbox ? t.nav.inbox : p.name}</h1>
        <div className="row">
          <button
            className="btn"
            onClick={() => onArchiveToggle(archived)}
            disabled={busy || p.is_inbox}
          >
            {archived ? t.project.unarchive : t.project.archive}
          </button>
          <button className="btn btn-primary" onClick={onNewChat} disabled={busy}>
            {t.nav.newChat}
          </button>
        </div>
      </div>

      {archived ? (
        <div className="banner banner-warn" role="status">
          {t.project.archived} — {t.project.archivedHint}
        </div>
      ) : null}

      {p.description ? <p className="muted">{p.description}</p> : null}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="badge">
          {t.project.approvalMode}: {p.approval_mode}
        </span>
        <span className="badge">
          {t.project.dataMode}: {p.data_mode}
        </span>
        <span className="badge">
          {t.project.status}: {p.status}
        </span>
      </div>

      <div className="section-title">{t.project.recentChats}</div>
      {chats.loading ? (
        <LoadingState />
      ) : chats.error ? (
        <ErrorState error={chats.error} onRetry={chats.reload} />
      ) : chats.data && chats.data.items.length > 0 ? (
        <div className="stack">
          {chats.data.items.map((c) => (
            <Link
              key={c.id}
              href={`/p/${projectId}/c/${c.id}`}
              className="card row"
              style={{ textDecoration: 'none' }}
            >
              <div style={{ flex: 1 }}>
                <strong>{c.title || t.nav.newChat}</strong>
                {c.pinned ? (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    pinned
                  </span>
                ) : null}
              </div>
              <span className="faint">#{c.message_seq}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card muted">{t.project.noChats}</div>
      )}

      <div className="section-title">{t.project.findingsTitle}</div>
      <div className="card muted">{t.project.noFindings}</div>
    </div>
  );
}

'use client';

/**
 * Chat + Workbench screen. The conversation transcript and live Workbench panels
 * are the T10b deliverable; here they are honest shells. The chat metadata IS
 * real (fetched from the API). A single sample assistant message demonstrates the
 * sanitizing Markdown renderer without pretending to be agent output — it is
 * clearly labelled as a rendering preview.
 */
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '../../../../../../i18n/index';
import { getChat } from '../../../../../../lib/endpoints';
import { ApiError } from '../../../../../../lib/api';
import { useAsync } from '../../../../../../lib/useAsync';
import { LoadingState, ErrorState } from '../../../../../../components/states';
import { Composer } from '../../../../../../components/Composer';
import { Workbench } from '../../../../../../components/Workbench';
import { SafeMarkdown } from '../../../../../../components/SafeMarkdown';
import type { Chat } from '../../../../../../lib/types';

/** Static sample for the Markdown-rendering preview (not agent output). */
const MARKDOWN_SAMPLE = [
  '## Markdown preview',
  '',
  'Assistant messages render as **sanitized** Markdown: `inline code`, lists, and',
  'safe [external links](https://example.com). Unsafe schemes and raw HTML never',
  'execute.',
  '',
  '- redacted tool inputs',
  '- verifiable results',
].join('\n');

export default function ChatPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ projectId: string; chatId: string }>();
  const { projectId, chatId } = params;
  const chat = useAsync<Chat>(() => getChat(projectId, chatId), [projectId, chatId]);

  return (
    <div className="chat-layout">
      <div className="chat-main">
        <div className="topbar" style={{ position: 'static' }}>
          <div className="row">
            <Link href={`/p/${projectId}`} className="btn">
              {t.common.back}
            </Link>
            <strong>
              {chat.loading ? t.common.loading : chat.data ? chat.data.title || t.nav.newChat : ''}
            </strong>
          </div>
        </div>

        <div className="transcript">
          {chat.loading ? (
            <LoadingState />
          ) : chat.error ? (
            chat.error instanceof ApiError && chat.error.status === 404 ? (
              <div className="banner banner-error" role="alert">
                {t.project.notFound}
              </div>
            ) : (
              <ErrorState error={chat.error} onRetry={chat.reload} />
            )
          ) : (
            <div className="stack">
              <div className="card muted stack">
                <strong>{t.common.comingWithAgent}</strong>
                <span>{t.chat.composerDisabledNote}</span>
              </div>
              {/* A labelled preview of the sanitizing Markdown renderer T10b will
                  use for assistant messages. This is NOT agent output — it is a
                  static rendering sample so the sanitizer is exercised in the UI. */}
              <div className="card stack">
                <span className="section-title">{t.chat.markdownPreview}</span>
                <SafeMarkdown source={MARKDOWN_SAMPLE} />
              </div>
            </div>
          )}
        </div>

        <Composer />
      </div>

      <Workbench />
    </div>
  );
}

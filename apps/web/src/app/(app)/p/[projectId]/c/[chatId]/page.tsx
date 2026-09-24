'use client';

/**
 * Chat + Workbench screen (T10b): the live conversation.
 *
 * On open it loads durable history and, if a run is still active, reconnects to
 * its event stream (never creating a new run). Sending an Ask message creates a
 * run with a fresh Idempotency-Key, shows an optimistic user bubble, then streams
 * the assistant reply (provisional → committed) rendered through SafeMarkdown. The
 * Workbench panels reflect only real run events. Agent runs are 501 this milestone,
 * so the Agent toggle stays disabled.
 */
import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '../../../../../../i18n/index';
import { getChat, listProviders } from '../../../../../../lib/endpoints';
import { ApiError } from '../../../../../../lib/api';
import { useAsync } from '../../../../../../lib/useAsync';
import { useChatRun } from '../../../../../../lib/realtime/useChatRun';
import { LoadingState, ErrorState } from '../../../../../../components/states';
import { Composer } from '../../../../../../components/Composer';
import { Workbench } from '../../../../../../components/Workbench';
import { MessageList } from '../../../../../../components/MessageList';
import type { Chat, ProviderConfig } from '../../../../../../lib/types';

export default function ChatPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ projectId: string; chatId: string }>();
  const { projectId, chatId } = params;

  const chat = useAsync<Chat>(() => getChat(projectId, chatId), [projectId, chatId]);
  const providers = useAsync<{ items: ProviderConfig[] }>(() => listProviders(), []);

  const run = useChatRun(projectId, chatId);

  const providerConfigId = useMemo(() => {
    const items = providers.data?.items ?? [];
    return items.find((p) => p.enabled)?.id ?? items[0]?.id ?? null;
  }, [providers.data]);

  const disabledReason = run.runActive
    ? t.chat.runActiveNote
    : providerConfigId === null && !providers.loading
      ? t.chat.noProviderNote
      : undefined;

  const sendDisabled = run.runActive || providerConfigId === null;

  const onSend = (text: string): void => {
    if (providerConfigId === null) return;
    void run.send({ text, providerConfigId });
  };

  const notFound = chat.error instanceof ApiError && chat.error.status === 404;

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
          {notFound ? (
            <div className="banner banner-error" role="alert">
              {t.project.notFound}
            </div>
          ) : run.loadingHistory ? (
            <LoadingState />
          ) : run.historyError ? (
            <ErrorState error={run.historyError} onRetry={run.reloadHistory} />
          ) : run.messages.length === 0 ? (
            <div className="card muted">{t.chat.historyEmpty}</div>
          ) : (
            <MessageList
              messages={run.messages}
              streamingLabel={t.chat.streaming}
              interruptedLabel={t.chat.interrupted}
            />
          )}
        </div>

        <Composer
          onSend={onSend}
          disabled={sendDisabled}
          {...(disabledReason ? { disabledReason } : {})}
          busy={run.sending}
          {...(run.sendError ? { error: run.sendError.message || t.chat.sendFailed } : {})}
        />
      </div>

      <Workbench
        runState={run.runState}
        budget={run.budget}
        plan={run.plan}
        activity={run.activity}
      />
    </div>
  );
}

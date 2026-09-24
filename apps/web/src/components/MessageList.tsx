'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * Transcript renderer (T10b).
 *
 * Each bubble is a `React.memo` component keyed by its stable `key`. The reducer
 * preserves object identity for every message it does not touch, so when a
 * streaming delta mutates only the last provisional bubble, only that one bubble
 * re-renders — a long transcript does not re-render O(n) bubbles per token.
 *
 * Assistant text is rendered through `SafeMarkdown`, which never uses
 * `dangerouslySetInnerHTML`, so unsafe Markdown/HTML stays inert. User text is
 * plain (no Markdown execution) to avoid rendering attacker-controlled input.
 */
import { memo } from 'react';
import type { TranscriptMessage } from '../lib/realtime/chatState';
import { SafeMarkdown } from './SafeMarkdown';

interface BubbleProps {
  role: TranscriptMessage['role'];
  text: string;
  status: TranscriptMessage['status'];
  provisional: boolean;
  streamingLabel: string;
  interruptedLabel: string;
}

function BubbleImpl(props: BubbleProps): JSX.Element {
  const { role, text, status, provisional, streamingLabel, interruptedLabel } = props;
  const isAssistant = role === 'assistant';
  return (
    <div className={`msg msg-${role}`} data-provisional={provisional || undefined}>
      <div className="msg-role faint">{role}</div>
      <div className="msg-body">
        {isAssistant ? (
          <SafeMarkdown source={text} />
        ) : (
          <div className="md">
            {text.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
        {provisional ? (
          <span className="badge" aria-live="polite">
            {streamingLabel}
          </span>
        ) : null}
        {status === 'interrupted' && !provisional ? (
          <span className="badge banner-warn">{interruptedLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

const Bubble = memo(BubbleImpl);

export interface MessageListProps {
  messages: TranscriptMessage[];
  streamingLabel: string;
  interruptedLabel: string;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const { messages, streamingLabel, interruptedLabel } = props;
  return (
    <div className="transcript-list stack">
      {messages.map((m) => (
        <Bubble
          key={m.key}
          role={m.role}
          text={m.text}
          status={m.status}
          provisional={m.provisional}
          streamingLabel={streamingLabel}
          interruptedLabel={interruptedLabel}
        />
      ))}
    </div>
  );
}

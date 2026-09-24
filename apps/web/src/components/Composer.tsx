'use client';

/**
 * Chat composer (docs/03 §5), wired to the live Ask transport in T10b.
 *
 * Keyboard / IME / focus behaviour is real and unchanged from the T10a shell:
 *   - Enter submits, Shift+Enter inserts a newline.
 *   - While an IME composition is active, Enter does NOT submit (Vietnamese/CJK).
 *   - Send is disabled when the trimmed text is empty, while a run is active in the
 *     chat (max_active_runs_chat = 1), while sending, or with no model provider.
 *
 * The Ask/Agent toggle keeps Ask selected; Agent stays disabled and clearly
 * labelled ("coming") because Agent runs are 501 this milestone. Sending is done
 * by the parent via `onSend`; the composer only owns its text + IME state.
 */
import { useRef, useState } from 'react';
import { useI18n } from '../i18n/index';

export interface ComposerProps {
  onSend: (text: string) => void;
  /** A run is active in this chat, or no provider/other reason blocks sending. */
  disabled: boolean;
  /** A short reason shown near the Send button when disabled. */
  disabledReason?: string;
  /** A create-run request is in flight. */
  busy?: boolean;
  /** Model-boundary chip label (external-redacted vs local). */
  modelLabel?: string;
  /** An error from the last send attempt. */
  error?: string | null;
}

export function Composer(props: ComposerProps): JSX.Element {
  const { onSend, disabled, disabledReason, busy = false, modelLabel, error } = props;
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasText = value.trim().length > 0;
  const canSend = hasText && !disabled && !busy;

  const attemptSend = (): void => {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
    // Keep focus in the composer for a fast back-and-forth.
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Do not submit mid-IME-composition (e.key would be 'Process' / isComposing).
      if (composingRef.current || e.nativeEvent.isComposing) return;
      e.preventDefault();
      attemptSend();
    }
  };

  return (
    <div className="composer">
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div className="row" role="group" aria-label="Ask / Agent" style={{ gap: 4 }}>
          <button className="btn btn-primary" aria-pressed={true} type="button">
            {t.chat.ask}
          </button>
          <button
            className="btn"
            aria-pressed={false}
            disabled
            title={t.common.comingWithAgent}
            type="button"
          >
            {t.chat.agent}
          </button>
        </div>
        <span className="badge" title={modelLabel ?? t.chat.modelExternal}>
          {modelLabel ?? t.chat.modelExternal}
        </span>
      </div>

      <textarea
        ref={textareaRef}
        className="textarea"
        placeholder={t.chat.composerPlaceholderLive}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        aria-label={t.chat.composerPlaceholderLive}
      />

      {error ? (
        <div className="banner banner-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <span className="faint">{disabled && disabledReason ? disabledReason : ''}</span>
        <button
          className="btn btn-primary"
          type="button"
          onClick={attemptSend}
          disabled={!canSend}
          title={disabled ? disabledReason : undefined}
        >
          {busy ? t.common.saving : t.chat.send}
        </button>
      </div>
    </div>
  );
}

'use client';

/**
 * Composer shell (docs/03 §5). The live send path (streaming a turn to the Agent)
 * arrives in T10b, so Send is disabled and clearly labelled — never a fake send.
 * The keyboard / IME / focus behaviour IS implemented for real so T10b only has to
 * wire the transport:
 *   - Enter submits, Shift+Enter inserts a newline.
 *   - While an IME composition is active, Enter does NOT submit (Vietnamese/CJK).
 *   - Send is disabled when the text (trimmed) and attachments are both empty.
 * The Ask/Agent toggle and the model-boundary chip reflect the intended UX; the
 * chip wording distinguishes an external (redacted) model from a local model.
 */
import { useRef, useState } from 'react';
import { useI18n } from '../i18n/index';

export function Composer(): JSX.Element {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<'ask' | 'agent'>('ask');
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0;

  // Send is intentionally inert until T10b wires the turn transport.
  const attemptSend = (): void => {
    // no-op shell: the real submit is T10b.
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Do not submit mid-IME-composition (e.key would be 'Process' / isComposing).
      if (composingRef.current || e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (canSend) attemptSend();
    }
  };

  return (
    <div className="composer">
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div className="row" role="group" aria-label="Ask / Agent" style={{ gap: 4 }}>
          <button
            className={`btn${mode === 'ask' ? ' btn-primary' : ''}`}
            aria-pressed={mode === 'ask'}
            onClick={() => setMode('ask')}
          >
            {t.chat.ask}
          </button>
          <button
            className={`btn${mode === 'agent' ? ' btn-primary' : ''}`}
            aria-pressed={mode === 'agent'}
            onClick={() => setMode('agent')}
          >
            {t.chat.agent}
          </button>
        </div>
        {/* Model-boundary chip: wording depends on the route/data mode, not worker
            location. In this shell we show the external-redacted default; T10b sets
            it from the resolved run config. */}
        <span className="badge" title={t.chat.modelExternal}>
          {t.chat.modelExternal}
        </span>
      </div>

      <textarea
        ref={textareaRef}
        className="textarea"
        placeholder={t.chat.composerPlaceholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        aria-label={t.chat.composerPlaceholder}
      />

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <span className="faint">{t.chat.composerDisabledNote}</span>
        <button className="btn btn-primary" disabled title={t.common.comingWithAgent}>
          {t.chat.send}
        </button>
      </div>
    </div>
  );
}

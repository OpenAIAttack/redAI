// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { TranscriptMessage } from '../lib/realtime/chatState';

/**
 * The transcript renders assistant text through SafeMarkdown, so unsafe HTML and
 * unsafe link schemes never execute. User text is plain (no Markdown), so it
 * cannot inject markup either.
 */
afterEach(() => cleanup());

function msg(over: Partial<TranscriptMessage> & { key: string }): TranscriptMessage {
  return {
    id: over.key,
    role: 'assistant',
    text: '',
    status: 'completed',
    provisional: false,
    ...over,
  };
}

function renderList(messages: TranscriptMessage[]) {
  return render(
    createElement(MessageList, {
      messages,
      streamingLabel: 'streaming',
      interruptedLabel: 'interrupted',
    }),
  );
}

describe('MessageList', () => {
  it('renders assistant Markdown but keeps raw HTML inert', () => {
    const { container } = renderList([
      msg({ key: 'a1', role: 'assistant', text: '<script>alert(1)</script>\n\n**bold**' }),
    ]);
    // No script element ever reaches the DOM.
    expect(container.querySelector('script')).toBeNull();
    // The literal tag text is present (rendered as text, not executed).
    expect(container.textContent).toContain('<script>alert(1)</script>');
    // Markdown still formats.
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('drops an unsafe link scheme, keeping the label as text', () => {
    const { container } = renderList([
      msg({ key: 'a2', role: 'assistant', text: '[click](javascript:alert(1))' }),
    ]);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click');
  });

  it('shows a streaming badge on a provisional bubble', () => {
    renderList([
      msg({
        key: 'a3',
        role: 'assistant',
        text: 'partial',
        provisional: true,
        status: 'streaming',
      }),
    ]);
    expect(screen.getByText('streaming')).toBeTruthy();
  });

  it('renders user text without executing markup', () => {
    const { container } = renderList([
      msg({ key: 'u1', role: 'user', text: '<img src=x onerror=alert(1)>' }),
    ]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

'use client';
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * A deliberately small, safe Markdown renderer (docs/03 §6).
 *
 * Safety model: it NEVER uses `dangerouslySetInnerHTML`. Every token is emitted
 * as a React element, so raw HTML in the source (e.g. `<script>`, `<img onerror>`)
 * is rendered as literal text and can never execute. Links are passed through
 * `sanitizeUrl` from @redai/ui, which drops `javascript:` and other unsafe
 * schemes. External links open in a new tab with `rel="noopener noreferrer"`.
 *
 * Supported: headings, paragraphs, fenced code blocks (with an optional language
 * label), inline code, bold, italic, links, and unordered/ordered lists. Anything
 * unrecognised degrades to plain text — safe by construction.
 */
import { Fragment, type ReactNode } from 'react';
import { sanitizeUrl } from '@redai/ui';

interface Props {
  source: string;
}

/** Inline parser: bold, italic, code, links. Returns React nodes, never HTML. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first (so its contents are not further parsed).
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t${i}`}>{text.slice(lastIndex, match.index)}</Fragment>,
      );
    }
    const token = match[0];
    const key = `${keyPrefix}-m${i}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      // link [label](url)
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const label = linkMatch[1] ?? '';
        const href = sanitizeUrl(linkMatch[2] ?? '');
        if (href) {
          const external = /^https?:/i.test(href);
          nodes.push(
            <a
              key={key}
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {label}
            </a>,
          );
        } else {
          // Unsafe scheme dropped: render the label as plain text.
          nodes.push(<Fragment key={key}>{label}</Fragment>);
        }
      } else {
        nodes.push(<Fragment key={key}>{token}</Fragment>);
      }
    }
    lastIndex = pattern.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-tend`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

export function SafeMarkdown({ source }: Props): JSX.Element {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume closing fence
      blocks.push(
        <pre key={key++} data-lang={lang || undefined}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Heading.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      const content = renderInline(heading[2] ?? '', `h${key}`);
      if (level === 1) blocks.push(<h1 key={key++}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++}>{content}</h2>);
      else blocks.push(<h3 key={key++}>{content}</h3>);
      i += 1;
      continue;
    }

    // List (unordered or ordered).
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        const itemText = (lines[i] ?? '').replace(/^\s*([-*]|\d+\.)\s+/, '');
        items.push(
          <li key={items.length}>{renderInline(itemText, `li${key}-${items.length}`)}</li>,
        );
        i += 1;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    // Blank line.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !(lines[i] ?? '').startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[i] ?? '') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')
    ) {
      paraLines.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paraLines.join(' '), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}

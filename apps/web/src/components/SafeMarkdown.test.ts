// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from './SafeMarkdown';

/**
 * The Markdown renderer must never emit executable HTML and must drop unsafe link
 * schemes (docs/03 §6). We render to static markup and assert on the output.
 */
function render(source: string): string {
  return renderToStaticMarkup(createElement(SafeMarkdown, { source }));
}

describe('SafeMarkdown', () => {
  it('renders raw HTML as inert text, never as elements', () => {
    const html = render('Hello <script>alert(1)</script> world');
    // The literal tag is escaped by React; no live <script> element exists.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops javascript: links but keeps the label text', () => {
    const html = render('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
    expect(html).not.toContain('href="javascript');
  });

  it('keeps safe http links and marks them external', () => {
    const html = render('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders fenced code blocks without executing content', () => {
    const html = render('```js\nconst x = 1;\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('const x = 1;');
  });

  it('renders bold and inline code', () => {
    const html = render('This is **bold** and `code`.');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });
});

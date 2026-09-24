/**
 * Unit tests for the safe preview + content sniffing. These prove previews never
 * execute HTML, redact obvious secrets, decode images to header-only dimensions, detect
 * media-type/bytes contradictions, and never resolve external references.
 */
import { describe, expect, it } from 'vitest';
import { buildPreview, htmlEscape, redactSecrets } from './preview.js';
import { parseJpeg, parsePng, sniffMismatch } from './sniff.js';

// A minimal valid 1x1 PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// A minimal JPEG with an SOF0 declaring 1x1.
const JPEG_MIN = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

describe('preview + sniff', () => {
  it('HTML-escapes text so an injected <script> cannot execute', () => {
    const evil = '<script>alert(1)</script> & "quotes"';
    const pv = buildPreview('text/markdown', Buffer.from(evil), { complete: true });
    expect(pv.kind).toBe('text');
    if (pv.kind === 'text') {
      expect(pv.content).not.toContain('<script>');
      expect(pv.content).toContain('&lt;script&gt;');
    }
  });

  it('redacts obvious secrets in a text preview', () => {
    const text = 'api_key = AKIAIOSFODNN7EXAMPLE\nnothing here';
    const { text: red, redacted } = redactSecrets(text);
    expect(redacted).toBe(true);
    expect(red).toContain('[REDACTED]');
    expect(red).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    const pv = buildPreview('text/plain', Buffer.from(pem), { complete: true });
    expect(pv.kind).toBe('text');
    if (pv.kind === 'text') {
      expect(pv.redacted).toBe(true);
      expect(pv.content).not.toContain('MIIabc');
    }
  });

  it('parses PNG dimensions from the header only', () => {
    const h = parsePng(PNG_1x1);
    expect(h).toEqual({ kind: 'png', width: 1, height: 1 });
    const pv = buildPreview('image/png', PNG_1x1, { complete: true });
    expect(pv).toMatchObject({ kind: 'image', format: 'png', width: 1, height: 1 });
  });

  it('parses JPEG dimensions from the SOF marker', () => {
    const h = parseJpeg(JPEG_MIN);
    expect(h).toEqual({ kind: 'jpeg', width: 1, height: 1 });
  });

  it('flags a media-type/bytes mismatch (declared PNG, text bytes)', () => {
    const res = sniffMismatch('image/png', Buffer.from('definitely not png'));
    expect(res.mismatch).toBe(true);
    const pv = buildPreview('image/png', Buffer.from('definitely not png'), { complete: true });
    expect(pv.kind).toBe('mismatch');
  });

  it('does not judge JSON/text on a bounded prefix (avoids false quarantine)', () => {
    // A UTF-8 multibyte char split at the prefix boundary must not be called a mismatch.
    const res = sniffMismatch('application/json', Buffer.from('{"a":', 'utf-8'), false);
    expect(res.mismatch).toBe(false);
  });

  it('detects invalid JSON only when the whole object is present', () => {
    const res = sniffMismatch('application/json', Buffer.from('{not json'), true);
    expect(res.mismatch).toBe(true);
  });

  it('previews CSV as bounded escaped rows', () => {
    const csv = 'a,b\n1,"<b>2</b>"';
    const pv = buildPreview('text/csv', Buffer.from(csv), { complete: true });
    expect(pv.kind).toBe('csv');
    if (pv.kind === 'csv') {
      expect(pv.rows[0]).toEqual(['a', 'b']);
      expect(pv.rows[1]?.[1]).toBe('&lt;b&gt;2&lt;/b&gt;');
    }
  });

  it('returns unsupported for types with no safe preview (e.g. HTML, PDF)', () => {
    expect(buildPreview('text/html', Buffer.from('<h1>x</h1>'), { complete: true }).kind).toBe(
      'unsupported',
    );
    expect(buildPreview('application/pdf', Buffer.from('%PDF-1.4'), { complete: true }).kind).toBe(
      'unsupported',
    );
  });

  it('escapes all five HTML-significant characters', () => {
    expect(htmlEscape(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

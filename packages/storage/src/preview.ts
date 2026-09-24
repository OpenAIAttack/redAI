/**
 * Bounded, safe, redacted previews. A preview is derived from at most
 * `preview_max_bytes` of an artifact and is NEVER a passthrough of raw bytes:
 *
 *  - Text-family (plain/markdown/yaml/csv/json) is decoded as UTF-8, HTML-escaped so a
 *    client that injects it into the DOM cannot execute `<script>` (docs/12 §9: target
 *    HTML with a script must not run), and passed through a conservative secret
 *    redactor so a raw secret canary never surfaces in a preview.
 *  - Images (png/jpeg) yield only header-derived dimensions, never pixel bytes.
 *  - Everything else is `unsupported` — the UI shows an honest "no preview" state and
 *    the owner can still download the raw bytes.
 *
 * No preview parser ever resolves an external reference (no URL fetch, no YAML anchor
 * expansion, no include) — it operates purely on the bytes in front of it.
 */
import { parseJpeg, parsePng, previewClassFor, sniffMismatch } from './sniff.js';

export interface TextPreview {
  kind: 'text';
  media_type: string;
  /** Escaped, redacted, bounded content. Safe to render as text/plain. */
  content: string;
  truncated: boolean;
  redacted: boolean;
}
export interface CsvPreview {
  kind: 'csv';
  media_type: string;
  /** Up to `maxRows` rows, each a bounded list of escaped+redacted cells. */
  rows: string[][];
  truncated: boolean;
  redacted: boolean;
}
export interface ImagePreview {
  kind: 'image';
  media_type: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}
export interface UnsupportedPreview {
  kind: 'unsupported';
  media_type: string;
  reason: string;
}
export interface MismatchPreview {
  kind: 'mismatch';
  media_type: string;
  reason: string;
}

export type Preview =
  TextPreview | CsvPreview | ImagePreview | UnsupportedPreview | MismatchPreview;

export interface PreviewOptions {
  /** Rows for a CSV preview (default 50). */
  maxRows?: number;
  /** Cells per CSV row (default 20). */
  maxCols?: number;
  /** Characters of text preview to return (default 65536). */
  maxChars?: number;
  /** Whether `bytes` is the whole object (true) or a bounded prefix (false, default). */
  complete?: boolean;
}

/** Escape the five HTML-significant characters so preview text can never execute. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Conservative secret patterns. These target well-known high-signal shapes; the goal is
// defence-in-depth for the preview surface, not a general DLP engine.
const PEM_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const ASSIGNED_SECRET =
  /\b(api[_-]?key|secret|token|password|passwd|authorization|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{8,}["']?/gi;
const KNOWN_KEY_PREFIX = /\b(?:AKIA|ASIA|sk-|ghp_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g;

/** Mask secret-looking substrings. Returns the redacted text and whether anything changed. */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const mask = (): string => {
    redacted = true;
    return '[REDACTED]';
  };
  const out = text
    .replace(PEM_BLOCK, mask)
    .replace(ASSIGNED_SECRET, (m) => {
      // Keep the field name, mask only the value.
      const idx = m.search(/[:=]/);
      redacted = true;
      return `${m.slice(0, idx + 1)} [REDACTED]`;
    })
    .replace(KNOWN_KEY_PREFIX, mask);
  return { text: out, redacted };
}

function safeText(
  raw: string,
  maxChars: number,
): { content: string; truncated: boolean; redacted: boolean } {
  const sliced = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  const { text, redacted } = redactSecrets(sliced);
  return { content: htmlEscape(text), truncated: raw.length > maxChars, redacted };
}

/** Minimal RFC-4180-ish CSV splitter (quotes, escaped quotes, commas, CRLF). Bounded. */
function parseCsv(text: string, maxRows: number, maxCols: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      if (row.length < maxCols) row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (row.length < maxCols) row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (rows.length < maxRows && (field.length > 0 || row.length > 0)) {
    if (row.length < maxCols) row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Build a preview from a bounded byte buffer (already capped at `preview_max_bytes` by
 * the caller). `mediaType` is the declared type; if the bytes contradict it we return a
 * `mismatch` preview so the API can refuse/quarantine rather than render a spoof.
 */
export function buildPreview(mediaType: string, bytes: Buffer, opts: PreviewOptions = {}): Preview {
  const cls = previewClassFor(mediaType);
  const maxChars = opts.maxChars ?? 65536;
  const maxRows = opts.maxRows ?? 50;
  const maxCols = opts.maxCols ?? 20;

  if (cls === 'unsupported') {
    return {
      kind: 'unsupported',
      media_type: mediaType,
      reason: 'preview not supported for this media type',
    };
  }

  const sniff = sniffMismatch(mediaType, bytes, opts.complete ?? false);
  if (sniff.mismatch) {
    return { kind: 'mismatch', media_type: mediaType, reason: sniff.reason };
  }

  if (cls === 'png') {
    const h = parsePng(bytes);
    return h
      ? { kind: 'image', media_type: mediaType, format: 'png', width: h.width, height: h.height }
      : { kind: 'mismatch', media_type: mediaType, reason: 'PNG header unreadable' };
  }
  if (cls === 'jpeg') {
    const h = parseJpeg(bytes);
    return h
      ? { kind: 'image', media_type: mediaType, format: 'jpeg', width: h.width, height: h.height }
      : {
          kind: 'unsupported',
          media_type: mediaType,
          reason: 'JPEG dimensions not found in preview window',
        };
  }

  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (cls === 'csv') {
    const { text, redacted } = redactSecrets(raw.length > maxChars ? raw.slice(0, maxChars) : raw);
    const rows = parseCsv(text, maxRows, maxCols).map((r) => r.map(htmlEscape));
    return {
      kind: 'csv',
      media_type: mediaType,
      rows,
      truncated: raw.length > maxChars,
      redacted,
    };
  }
  // text / markdown / yaml / json → escaped, redacted, bounded text.
  const t = safeText(raw, maxChars);
  return {
    kind: 'text',
    media_type: mediaType,
    content: t.content,
    truncated: t.truncated,
    redacted: t.redacted,
  };
}

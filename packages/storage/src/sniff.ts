/**
 * Content sniffing: does the byte content agree with the client-declared media type?
 *
 * The API trusts NEITHER the declared media type NOR the bytes on their own. At
 * finalize the server sniffs the observed bytes; a definitive contradiction (e.g. a
 * declared `image/png` whose magic bytes are not a PNG, or a declared
 * `application/json` that does not parse) is a spoof signal and quarantines the
 * artifact instead of publishing it `ready` (docs/12 §2). Sniffing is conservative:
 * it only reports a mismatch when it is *certain*, so honest uploads are never
 * quarantined by a heuristic.
 */

export type PreviewClass =
  'text' | 'markdown' | 'json' | 'yaml' | 'csv' | 'png' | 'jpeg' | 'unsupported';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Normalize a media type to its lowercase essence (drop parameters like `; charset=`). */
export function baseMediaType(mediaType: string): string {
  const semi = mediaType.indexOf(';');
  return (semi >= 0 ? mediaType.slice(0, semi) : mediaType).trim().toLowerCase();
}

/** Map a media type to the preview class we know how to render safely, if any. */
export function previewClassFor(mediaType: string): PreviewClass {
  switch (baseMediaType(mediaType)) {
    case 'text/plain':
      return 'text';
    case 'text/markdown':
    case 'text/x-markdown':
      return 'markdown';
    case 'application/json':
      return 'json';
    case 'application/yaml':
    case 'application/x-yaml':
    case 'text/yaml':
    case 'text/x-yaml':
      return 'yaml';
    case 'text/csv':
      return 'csv';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    default:
      return 'unsupported';
  }
}

export interface PngHeader {
  kind: 'png';
  width: number;
  height: number;
}
export interface JpegHeader {
  kind: 'jpeg';
  width: number;
  height: number;
}

/** Parse a PNG IHDR from the header. Returns null if the bytes are not a PNG. */
export function parsePng(bytes: Buffer): PngHeader | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  // IHDR is the first chunk: length(4) 'IHDR'(4) width(4) height(4) ...
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { kind: 'png', width, height };
}

/**
 * Parse JPEG dimensions by walking segment markers up to the first Start-Of-Frame.
 * Bounded to the buffer it is given (the preview window), so a truncated file simply
 * yields null rather than scanning unbounded.
 */
export function parseJpeg(bytes: Buffer): JpegHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1]!;
    // Skip fill bytes (0xFF padding).
    while (marker === 0xff && offset + 1 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1]!;
    }
    offset += 2;
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const segLen = bytes.readUInt16BE(offset);
    // SOF0..SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC) carry frame dimensions.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 7 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return null;
      return { kind: 'jpeg', width, height };
    }
    offset += segLen;
  }
  return null;
}

/** True if the buffer decodes as well-formed UTF-8 with no lone surrogates / NUL runs. */
export function looksLikeUtf8Text(bytes: Buffer): boolean {
  // A NUL byte is a strong signal of binary content, not text.
  if (bytes.includes(0x00)) return false;
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    dec.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface SniffResult {
  /** True when the observed bytes definitively contradict the declared media type. */
  mismatch: boolean;
  /** A short, non-sensitive reason for logs/tests; empty when there is no mismatch. */
  reason: string;
}

/**
 * Sniff `bytes` against the declared media type. Only *definitive* contradictions are
 * reported. `complete` says whether `bytes` is the WHOLE object (true) or a bounded
 * prefix (false) — text/JSON contradictions are only judged on the whole object, so a
 * multi-byte character split at a prefix boundary, or a large-but-valid JSON, is never
 * wrongly quarantined. Magic-byte checks (PNG/JPEG) work on a prefix and always run.
 */
export function sniffMismatch(mediaType: string, bytes: Buffer, complete = true): SniffResult {
  const cls = previewClassFor(mediaType);
  switch (cls) {
    case 'png':
      return parsePng(bytes)
        ? { mismatch: false, reason: '' }
        : { mismatch: true, reason: 'declared PNG but bytes are not a PNG' };
    case 'jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? { mismatch: false, reason: '' }
        : { mismatch: true, reason: 'declared JPEG but bytes are not a JPEG' };
    case 'json': {
      if (!complete) return { mismatch: false, reason: '' };
      if (!looksLikeUtf8Text(bytes)) {
        return { mismatch: true, reason: 'declared JSON but bytes are not text' };
      }
      try {
        JSON.parse(bytes.toString('utf-8'));
        return { mismatch: false, reason: '' };
      } catch {
        return { mismatch: true, reason: 'declared JSON but bytes do not parse' };
      }
    }
    case 'text':
    case 'markdown':
    case 'yaml':
    case 'csv':
      if (!complete) return { mismatch: false, reason: '' };
      return looksLikeUtf8Text(bytes)
        ? { mismatch: false, reason: '' }
        : { mismatch: true, reason: 'declared text but bytes are not valid UTF-8' };
    case 'unsupported':
    default:
      // We do not sniff types we do not preview (arbitrary binary evidence is allowed).
      return { mismatch: false, reason: '' };
  }
}

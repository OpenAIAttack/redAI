/**
 * Opaque keyset-pagination cursor for chat history. Messages carry a per-chat
 * monotonic `seq` (bigint), so a page seeks strictly after the last returned `seq`
 * (`seq > cursor`), stable under concurrent inserts. The encoding is deliberately
 * opaque (base64url) so callers treat it as a token, not a queryable offset (docs/06 §1).
 */

export function encodeCursor(seq: string): string {
  return Buffer.from(`seq:${seq}`, 'utf8').toString('base64url');
}

/** Decode a cursor to its `seq`, or null when malformed (treated as "from start"). */
export function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith('seq:')) return null;
    const seq = raw.slice(4);
    if (seq === '' || !/^[0-9]+$/.test(seq)) return null;
    return seq;
  } catch {
    return null;
  }
}

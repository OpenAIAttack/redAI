/**
 * Opaque keyset-pagination cursor. Lists order by `(updated_at DESC, id DESC)` and
 * the cursor carries the last row's `(updatedAt, id)` so the next page is a strict
 * `<` seek — stable under inserts and matching docs/03 §4 ("Danh sách tải theo
 * cursor"). The encoding is deliberately opaque (base64url) so callers treat it as a
 * token, not a queryable offset.
 */

export interface CursorKey {
  updatedAt: Date;
  id: string;
}

export function encodeCursor(key: CursorKey): string {
  const raw = `${key.updatedAt.toISOString()}|${key.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor, or return null when it is malformed (treated as "from start"). */
export function decodeCursor(cursor: string | undefined): CursorKey | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const updatedAt = new Date(iso);
    if (Number.isNaN(updatedAt.getTime()) || id === '') return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

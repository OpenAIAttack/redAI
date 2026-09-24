/**
 * Opaque keyset-pagination cursor for artifact lists, ordered `(created_at DESC, id
 * DESC)`. Mirrors the projects cursor (a separate copy keeps the artifacts module free
 * of a cross-module import). The token is opaque base64url — callers treat it as a
 * token, not a queryable offset.
 */

export interface CursorKey {
  createdAt: Date;
  id: string;
}

export function encodeCursor(key: CursorKey): string {
  const raw = `${key.createdAt.toISOString()}|${key.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor, or return null when malformed (treated as "from start"). */
export function decodeCursor(cursor: string | undefined): CursorKey | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || id === '') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

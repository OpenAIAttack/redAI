/**
 * Typed storage failures. Each carries a stable `code` the application/API layer maps
 * to an error envelope. Messages never embed host filesystem paths, secrets or target
 * bytes (AGENTS.md: no host path in responses, no secret in logs) — only the logical
 * key or a short reason.
 */

export type StorageErrorCode =
  | 'PATH_INVALID' // key escaped the root, traversal, absolute, NUL or bad chars
  | 'SYMLINK_REJECTED' // a symlink was encountered on the resolved object path
  | 'NOT_STAGED' // finalize found neither staged bytes nor a recovered object
  | 'HASH_MISMATCH' // observed sha256/size differs from the declared values
  | 'SIZE_EXCEEDED' // upload body exceeded the configured cap
  | 'NOT_FOUND' // object bytes are absent for the given key
  | 'WRITE_FAILED' // an IO write/rename failed (disk full, read-only, interrupted)
  | 'READ_FAILED'; // an IO read failed

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  /** Optional non-sensitive cause tag (e.g. an errno like `ENOSPC`) for diagnostics. */
  public readonly cause_code: string | undefined;
  public constructor(code: StorageErrorCode, message: string, causeCode?: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause_code = causeCode;
  }
}

/** Structural guard usable across package boundaries without a runtime class import. */
export function isStorageError(err: unknown): err is StorageError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  return e.name === 'StorageError' && typeof e.code === 'string' && typeof e.message === 'string';
}

/** The subset of Node errno codes that mean "no space / write refused / interrupted". */
export function errnoOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

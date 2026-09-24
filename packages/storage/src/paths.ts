/**
 * Path-safety primitives for the local ObjectStore. Every byte that reaches disk goes
 * through here so a logical `storage_key` can NEVER escape the configured object root,
 * follow a symlink, or resolve to a host path we hand back to a caller.
 *
 * A logical key is a `/`-joined list of path segments; the store maps it to
 * `<root>/objects/<key>`. Keys are produced by the server from UUIDs, but we still
 * validate defensively (INV: a valid-looking string is not authorization to touch the
 * filesystem) so a compromised caller cannot inject `..`, an absolute path or a NUL.
 */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StorageError } from './errors.js';

/** A single key segment: lowercase hex, digits, dash, underscore or dot — no slashes. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a logical storage key and return its normalized segments. Rejects empty
 * keys, absolute paths, `.`/`..` segments, backslashes, NUL bytes and any segment with
 * characters outside the safe set. Throws {@link StorageError} `PATH_INVALID`.
 */
export function validateKey(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
    throw new StorageError('PATH_INVALID', 'storage key is empty or too long');
  }
  if (key.includes('\0')) throw new StorageError('PATH_INVALID', 'storage key contains NUL');
  if (key.includes('\\')) throw new StorageError('PATH_INVALID', 'storage key contains backslash');
  if (isAbsolute(key)) throw new StorageError('PATH_INVALID', 'storage key must be relative');
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new StorageError('PATH_INVALID', 'storage key has an empty or dot segment');
    }
    if (!SEGMENT_RE.test(seg)) {
      throw new StorageError('PATH_INVALID', 'storage key segment has invalid characters');
    }
  }
  return segments;
}

/**
 * Resolve a validated key to an absolute path under `objectsRoot`, asserting the result
 * stays inside the root even after normalization. Pure string math — it does not touch
 * the filesystem, so it is safe to call before the target exists.
 */
export function resolveWithinRoot(objectsRoot: string, key: string): string {
  const segments = validateKey(key);
  const abs = resolve(objectsRoot, join(...segments));
  const rel = relative(objectsRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new StorageError('PATH_INVALID', 'storage key escapes the object root');
  }
  return abs;
}

/**
 * Assert that no component of `absPath` between `root` (exclusive) and the leaf
 * (inclusive) is a symbolic link, and that its realpath — if it exists — is still
 * inside `root`. This closes the symlink-escape hole: an attacker who plants a symlink
 * inside the object tree cannot make a read/write follow it out of the store.
 *
 * `root` itself is trusted (the operator configured it) and is resolved once via
 * realpath so a symlinked *root* is allowed, but nothing below it may be a symlink.
 */
export async function assertNoSymlink(root: string, absPath: string): Promise<void> {
  const realRoot = await realpath(root);
  const rel = relative(realRoot, resolve(absPath));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    // Path is outside the (real) root — either it never was inside, or a parent is a
    // symlink pointing out. Either way, refuse.
    throw new StorageError('SYMLINK_REJECTED', 'path resolves outside the object root');
  }
  const parts = rel.split(sep).filter((p) => p.length > 0);
  let cur = realRoot;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        throw new StorageError('SYMLINK_REJECTED', 'a symlink was encountered on the path');
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      // ENOENT for a not-yet-created leaf/parent is fine for a write target; the caller
      // creates the directory chain with mkdir (which does not follow symlinks for the
      // final component) and re-checks the leaf after write.
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') return;
      throw err;
    }
  }
}

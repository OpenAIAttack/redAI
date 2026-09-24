/**
 * Local-filesystem ObjectStore (architecture §1: bytes live in a local ObjectStore
 * shared only between API and runtime, never mounted into a sandbox). Behind the
 * {@link ObjectStore} interface (§9: storage injected as a small interface) so callers
 * and tests swap implementations.
 *
 * Layout under the configured root:
 *   <root>/staging/<artifactId>          uploaded bytes, before verification
 *   <root>/objects/<storageKey>          verified bytes, addressed by logical key
 *
 * The finalize sequence is: write staged bytes → server computes sha256 + size →
 * verify against the client-declared values → atomic rename staging → objects/<key>.
 * The rename is the only step that makes bytes visible at the logical key, and it is
 * atomic on a single filesystem, so a reader never sees a half-written object. DB and
 * filesystem are not one atomic system: a crash between the rename and the DB commit
 * leaves a finalized file with a non-`ready` row (an orphan) — handled by
 * {@link ObjectStore.finalize}'s recovery path and by reconciliation, and never served
 * because downloads require a `ready` row.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { StorageError, errnoOf } from './errors.js';
import { assertNoSymlink, resolveWithinRoot, validateKey } from './paths.js';
import { sniffMismatch } from './sniff.js';

/** Server-derived logical key for an artifact: `<workspaceId>/<projectId>/<artifactId>`. */
export function logicalStorageKey(
  workspaceId: string,
  projectId: string,
  artifactId: string,
): string {
  return `${workspaceId}/${projectId}/${artifactId}`;
}

export interface DeclaredBytes {
  sha256: string;
  byteSize: number;
}

export interface WriteStagingResult {
  sha256: string;
  byteSize: number;
}

export type FinalizeOutcome =
  | {
      ok: true;
      sha256: string;
      byteSize: number;
      /** True when the observed bytes contradict `mediaType` → caller must quarantine. */
      contentMismatch: boolean;
      mismatchReason: string;
    }
  | { ok: false; reason: 'not-staged' }
  | { ok: false; reason: 'hash-mismatch'; observed: { sha256: string; byteSize: number } };

export interface FinalizeParams {
  artifactId: string;
  storageKey: string;
  declared: DeclaredBytes;
  mediaType: string;
}

export interface ReadHandle {
  stream: Readable;
  byteSize: number;
}

export interface StagingEntry {
  artifactId: string;
  mtimeMs: number;
  byteSize: number;
}

export interface ObjectStore {
  /** Absolute-path-free: keys only. Write staged bytes for an artifact, capped at maxBytes. */
  writeStaging(
    artifactId: string,
    data: Buffer | AsyncIterable<Buffer>,
    opts: { maxBytes: number },
  ): Promise<WriteStagingResult>;
  /** Verify staged (or crash-recovered) bytes against `declared` and atomically publish. */
  finalize(params: FinalizeParams): Promise<FinalizeOutcome>;
  /** Open verified bytes for streaming download (symlink-guarded). */
  openRead(storageKey: string): Promise<ReadHandle>;
  /** Read a bounded prefix of an object for previewing (symlink-guarded). */
  readBounded(storageKey: string, maxBytes: number): Promise<Buffer>;
  objectExists(storageKey: string): Promise<boolean>;
  removeObject(storageKey: string): Promise<void>;
  removeStaging(artifactId: string): Promise<void>;
  /** All logical object keys currently on disk (for reconciliation). */
  listObjectKeys(): Promise<string[]>;
  /** All staging entries currently on disk (for reconciliation of abandoned uploads). */
  listStaging(): Promise<StagingEntry[]>;
}

const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertArtifactId(artifactId: string): void {
  if (
    typeof artifactId !== 'string' ||
    artifactId.length === 0 ||
    artifactId.length > 255 ||
    !ARTIFACT_ID_RE.test(artifactId)
  ) {
    throw new StorageError('PATH_INVALID', 'invalid artifact id for staging');
  }
}

export interface LocalObjectStoreOptions {
  /** Filesystem root the store owns. Created if missing. */
  root: string;
}

export class LocalObjectStore implements ObjectStore {
  private readonly stagingRoot: string;
  private readonly objectsRoot: string;
  private ensured = false;

  public constructor(opts: LocalObjectStoreOptions) {
    this.stagingRoot = join(opts.root, 'staging');
    this.objectsRoot = join(opts.root, 'objects');
  }

  private async ensureRoots(): Promise<void> {
    if (this.ensured) return;
    await mkdir(this.stagingRoot, { recursive: true });
    await mkdir(this.objectsRoot, { recursive: true });
    this.ensured = true;
  }

  private stagingPath(artifactId: string): string {
    assertArtifactId(artifactId);
    return join(this.stagingRoot, artifactId);
  }

  async writeStaging(
    artifactId: string,
    data: Buffer | AsyncIterable<Buffer>,
    opts: { maxBytes: number },
  ): Promise<WriteStagingResult> {
    await this.ensureRoots();
    const finalStaging = this.stagingPath(artifactId);
    // Write to a per-attempt temp file, then rename into the staging slot so a partial
    // write is never visible as "staged". A crash leaves only a `.part` to reap.
    const tmp = `${finalStaging}.part-${process.pid}-${Date.now()}`;
    const hash = createHash('sha256');
    let byteSize = 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      const chunks: Iterable<Buffer> | AsyncIterable<Buffer> = Buffer.isBuffer(data)
        ? [data]
        : data;
      for await (const chunk of chunks as AsyncIterable<Buffer>) {
        byteSize += chunk.length;
        if (byteSize > opts.maxBytes) {
          throw new StorageError('SIZE_EXCEEDED', 'upload exceeds the configured maximum');
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, finalStaging);
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      if (err instanceof StorageError) throw err;
      throw new StorageError('WRITE_FAILED', 'failed to write staged upload', errnoOf(err));
    }
    return { sha256: hash.digest('hex'), byteSize };
  }

  async finalize(params: FinalizeParams): Promise<FinalizeOutcome> {
    await this.ensureRoots();
    validateKey(params.storageKey);
    const objectPath = resolveWithinRoot(this.objectsRoot, params.storageKey);
    const stagingPath = this.stagingPath(params.artifactId);

    // Recovery path: a prior finalize may have renamed into the object slot but crashed
    // before the DB commit. If the object already exists, verify IT (idempotent).
    const objExists = await this.exists(objectPath);
    if (objExists) {
      await assertNoSymlink(this.objectsRoot, objectPath);
      const observed = await hashFile(objectPath);
      // Clean up any leftover staging for the same artifact.
      await rm(stagingPath, { force: true }).catch(() => {});
      if (
        observed.sha256 !== params.declared.sha256 ||
        observed.byteSize !== params.declared.byteSize
      ) {
        return { ok: false, reason: 'hash-mismatch', observed };
      }
      const sniff = await sniffObject(objectPath, params.mediaType, observed.byteSize);
      return {
        ok: true,
        sha256: observed.sha256,
        byteSize: observed.byteSize,
        contentMismatch: sniff.mismatch,
        mismatchReason: sniff.reason,
      };
    }

    // Normal path: verify staged bytes.
    if (!(await this.exists(stagingPath))) {
      return { ok: false, reason: 'not-staged' };
    }
    const observed = await hashFile(stagingPath);
    if (
      observed.sha256 !== params.declared.sha256 ||
      observed.byteSize !== params.declared.byteSize
    ) {
      // Leave staging in place so the caller can decide to retry or discard; the row
      // stays `pending`, so nothing is ever served.
      return { ok: false, reason: 'hash-mismatch', observed };
    }
    const sniff = await sniffObject(stagingPath, params.mediaType, observed.byteSize);

    // Atomic publish: mkdir the key's parent, guard against symlinks, then rename. Any
    // IO failure here (disk full, read-only, a blocked path) leaves the staged bytes in
    // place and publishes nothing — the row stays `pending`, so nothing is ever served.
    try {
      await mkdir(dirname(objectPath), { recursive: true });
      await assertNoSymlink(this.objectsRoot, objectPath);
      await rename(stagingPath, objectPath);
      // Re-assert the published leaf is not a symlink (defence in depth).
      await assertNoSymlink(this.objectsRoot, objectPath);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('WRITE_FAILED', 'failed to publish object', errnoOf(err));
    }
    return {
      ok: true,
      sha256: observed.sha256,
      byteSize: observed.byteSize,
      contentMismatch: sniff.mismatch,
      mismatchReason: sniff.reason,
    };
  }

  async openRead(storageKey: string): Promise<ReadHandle> {
    const objectPath = resolveWithinRoot(this.objectsRoot, storageKey);
    await assertNoSymlink(this.objectsRoot, objectPath);
    let byteSize: number;
    try {
      const st = await stat(objectPath);
      if (!st.isFile()) throw new StorageError('NOT_FOUND', 'object is not a regular file');
      byteSize = st.size;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR')
        throw new StorageError('NOT_FOUND', 'object bytes not found');
      throw new StorageError('READ_FAILED', 'failed to stat object', errnoOf(err));
    }
    return { stream: createReadStream(objectPath), byteSize };
  }

  async readBounded(storageKey: string, maxBytes: number): Promise<Buffer> {
    const objectPath = resolveWithinRoot(this.objectsRoot, storageKey);
    await assertNoSymlink(this.objectsRoot, objectPath);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(objectPath, 'r');
      const st = await handle.stat();
      if (!st.isFile()) throw new StorageError('NOT_FOUND', 'object is not a regular file');
      const len = Math.min(maxBytes, st.size);
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const { bytesRead } = await handle.read(buf, read, len - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === len ? buf : buf.subarray(0, read);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR')
        throw new StorageError('NOT_FOUND', 'object bytes not found');
      throw new StorageError('READ_FAILED', 'failed to read object', errnoOf(err));
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async objectExists(storageKey: string): Promise<boolean> {
    const objectPath = resolveWithinRoot(this.objectsRoot, storageKey);
    return this.exists(objectPath);
  }

  async removeObject(storageKey: string): Promise<void> {
    const objectPath = resolveWithinRoot(this.objectsRoot, storageKey);
    await rm(objectPath, { force: true });
  }

  async removeStaging(artifactId: string): Promise<void> {
    const stagingPath = this.stagingPath(artifactId);
    await rm(stagingPath, { force: true });
  }

  async listObjectKeys(): Promise<string[]> {
    await this.ensureRoots();
    const keys: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else if (e.isFile()) keys.push(rel);
        // Symlinks and other node types are intentionally ignored (never valid objects).
      }
    };
    await walk(this.objectsRoot, '');
    return keys;
  }

  async listStaging(): Promise<StagingEntry[]> {
    await this.ensureRoots();
    let entries;
    try {
      entries = await readdir(this.stagingRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: StagingEntry[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      // Skip in-flight temp files; only settled staging slots are reconciled.
      if (e.name.includes('.part-')) continue;
      try {
        const st = await stat(join(this.stagingRoot, e.name));
        out.push({ artifactId: e.name, mtimeMs: st.mtimeMs, byteSize: st.size });
      } catch {
        // vanished between readdir and stat — ignore.
      }
    }
    return out;
  }

  private async exists(absPath: string): Promise<boolean> {
    try {
      await stat(absPath);
      return true;
    } catch (err) {
      // ENOENT: nothing there. ENOTDIR: a parent component is a file, so the object
      // cannot exist — treat both as absent and let the write path surface the IO error.
      const code = errnoOf(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw err;
    }
  }
}

async function hashFile(absPath: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  const handle = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      byteSize += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), byteSize };
}

async function sniffObject(
  absPath: string,
  mediaType: string,
  byteSize: number,
): Promise<{ mismatch: boolean; reason: string }> {
  // Read a bounded prefix (enough for magic bytes / a small JSON) for the sniff.
  const cap = Math.min(byteSize, 1 << 20);
  const handle = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(cap);
    let read = 0;
    while (read < cap) {
      const { bytesRead } = await handle.read(buf, read, cap - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const complete = read >= byteSize;
    return sniffMismatch(mediaType, buf.subarray(0, read), complete);
  } finally {
    await handle.close();
  }
}

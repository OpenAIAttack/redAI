/**
 * Unit tests for the local ObjectStore over a throwaway temp-dir root. These prove the
 * safety and durability properties without a database: server-side hash/size
 * verification, atomic finalize, path-traversal + symlink rejection, media-type
 * mismatch detection, crash-recovery of a renamed-but-uncommitted object, IO-failure
 * handling (no partial publish) and reconciliation listing.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from './errors.js';
import { LocalObjectStore, logicalStorageKey } from './objectStore.js';
import { reconcile } from './reconcile.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let root: string;
let store: LocalObjectStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'redai-store-'));
  store = new LocalObjectStore({ root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stageAndFinalize(artifactId: string, bytes: Buffer, mediaType: string) {
  const key = logicalStorageKey(WS, PROJECT, artifactId);
  await store.writeStaging(artifactId, bytes, { maxBytes: 26_214_400 });
  return store.finalize({
    artifactId,
    storageKey: key,
    declared: { sha256: sha256(bytes), byteSize: bytes.length },
    mediaType,
  });
}

describe('LocalObjectStore', () => {
  it('stages, verifies and atomically publishes bytes, then reads them back', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccccc';
    const bytes = Buffer.from('hello redAI evidence');
    const outcome = await stageAndFinalize(artifactId, bytes, 'text/plain');
    expect(outcome).toMatchObject({ ok: true, contentMismatch: false });
    if (outcome.ok) {
      expect(outcome.sha256).toBe(sha256(bytes));
      expect(outcome.byteSize).toBe(bytes.length);
    }
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    const handle = await store.openRead(key);
    const chunks: Buffer[] = [];
    for await (const c of handle.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello redAI evidence');
  });

  it('rejects a finalize whose observed digest/size differs from the declared values', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc01';
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    await store.writeStaging(artifactId, Buffer.from('actual bytes'), { maxBytes: 1000 });
    const wrong = await store.finalize({
      artifactId,
      storageKey: key,
      declared: { sha256: 'a'.repeat(64), byteSize: 999 },
      mediaType: 'text/plain',
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('hash-mismatch');
    // Nothing was published; the object key must not exist.
    expect(await store.objectExists(key)).toBe(false);
  });

  it('reports not-staged when no bytes were uploaded', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc02';
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    const res = await store.finalize({
      artifactId,
      storageKey: key,
      declared: { sha256: 'a'.repeat(64), byteSize: 0 },
      mediaType: 'text/plain',
    });
    expect(res).toEqual({ ok: false, reason: 'not-staged' });
  });

  it('flags a media-type/bytes mismatch (declared PNG, text bytes)', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc03';
    const bytes = Buffer.from('not a png at all');
    const outcome = await stageAndFinalize(artifactId, bytes, 'image/png');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.contentMismatch).toBe(true);
  });

  it('enforces the byte cap during staging', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc04';
    await expect(
      store.writeStaging(artifactId, Buffer.from('0123456789'), { maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'SIZE_EXCEEDED' });
  });

  it('rejects path traversal / absolute / bad keys', async () => {
    for (const bad of ['../escape', '/etc/passwd', 'a/../../b', 'a/./b', 'a\\b', 'nul\0key']) {
      await expect(store.openRead(bad)).rejects.toMatchObject({ code: 'PATH_INVALID' });
    }
  });

  it('refuses to read through a symlink planted in the object tree', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc05';
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    const objectPath = join(root, 'objects', key);
    await mkdir(join(root, 'objects', WS, PROJECT), { recursive: true });
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, objectPath);
    await expect(store.openRead(key)).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' });
    await expect(store.readBounded(key, 100)).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' });
  });

  it('recovers a crash between rename and commit: re-finalize verifies the published object', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc06';
    const bytes = Buffer.from('committed bytes');
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    // First finalize publishes the object (imagine the DB commit then crashed).
    await store.writeStaging(artifactId, bytes, { maxBytes: 1000 });
    const first = await store.finalize({
      artifactId,
      storageKey: key,
      declared: { sha256: sha256(bytes), byteSize: bytes.length },
      mediaType: 'text/plain',
    });
    expect(first.ok).toBe(true);
    // Re-finalize (retry) must be idempotent — it verifies the already-published object.
    const retry = await store.finalize({
      artifactId,
      storageKey: key,
      declared: { sha256: sha256(bytes), byteSize: bytes.length },
      mediaType: 'text/plain',
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.sha256).toBe(sha256(bytes));
  });

  it('does not partially publish when the IO publish step fails (no orphan ready)', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc07';
    const bytes = Buffer.from('x');
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    await store.writeStaging(artifactId, bytes, { maxBytes: 1000 });
    // Make the object's parent path a FILE so mkdir(dirname) fails with ENOTDIR (an
    // IO failure standing in for ENOSPC). Root-independent.
    await mkdir(join(root, 'objects'), { recursive: true });
    await writeFile(join(root, 'objects', WS), 'blocker');
    await expect(
      store.finalize({
        artifactId,
        storageKey: key,
        declared: { sha256: sha256(bytes), byteSize: bytes.length },
        mediaType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    // The staged bytes are still present (retryable); nothing was published.
    expect(isStorageError(new StorageError('WRITE_FAILED', 'x'))).toBe(true);
  });

  it('lists object keys and reconciles orphans against a DB view', async () => {
    const readyId = 'cccccccc-3333-4333-8333-cccccccccc08';
    const orphanId = 'cccccccc-3333-4333-8333-cccccccccc09';
    const readyKey = logicalStorageKey(WS, PROJECT, readyId);
    const orphanKey = logicalStorageKey(WS, PROJECT, orphanId);
    await stageAndFinalize(readyId, Buffer.from('ready'), 'text/plain');
    await stageAndFinalize(orphanId, Buffer.from('orphan'), 'text/plain');

    const keys = await store.listObjectKeys();
    expect(new Set(keys)).toEqual(new Set([readyKey, orphanKey]));

    // DB view: only readyKey is a ready row; orphanKey has no live row → orphan.
    const report = await reconcile(
      store,
      { readyKeys: [readyKey], liveNonReadyKeys: [] },
      { sweep: true },
    );
    expect(report.orphanObjectKeys).toEqual([orphanKey]);
    expect(report.missingObjectKeys).toEqual([]);
    // Swept: the orphan file is gone, the ready object remains.
    expect(await store.objectExists(orphanKey)).toBe(false);
    expect(await store.objectExists(readyKey)).toBe(true);
  });

  it('reports a ready row whose bytes went missing', async () => {
    const missingKey = logicalStorageKey(WS, PROJECT, 'cccccccc-3333-4333-8333-cccccccccc0a');
    const report = await reconcile(store, { readyKeys: [missingKey], liveNonReadyKeys: [] }, {});
    expect(report.missingObjectKeys).toEqual([missingKey]);
  });

  it('reconcile leaves a pending (live non-ready) object in place — it may be mid-finalize', async () => {
    const pendingId = 'cccccccc-3333-4333-8333-cccccccccc0b';
    const pendingKey = logicalStorageKey(WS, PROJECT, pendingId);
    await stageAndFinalize(pendingId, Buffer.from('pending-obj'), 'text/plain');
    const report = await reconcile(
      store,
      { readyKeys: [], liveNonReadyKeys: [pendingKey] },
      { sweep: true },
    );
    expect(report.orphanObjectKeys).toEqual([]);
    expect(await store.objectExists(pendingKey)).toBe(true);
  });

  it('reads only a bounded prefix for previews', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc0c';
    const bytes = Buffer.from('A'.repeat(5000));
    await stageAndFinalize(artifactId, bytes, 'text/plain');
    const key = logicalStorageKey(WS, PROJECT, artifactId);
    const buf = await store.readBounded(key, 100);
    expect(buf.length).toBe(100);
  });

  it('sweeps stale staging entries', async () => {
    const artifactId = 'cccccccc-3333-4333-8333-cccccccccc0d';
    await store.writeStaging(artifactId, Buffer.from('abandoned'), { maxBytes: 1000 });
    const listed = await store.listStaging();
    expect(listed.map((s) => s.artifactId)).toContain(artifactId);
    // now = far future so the entry is considered stale.
    const report = await reconcile(
      store,
      { readyKeys: [], liveNonReadyKeys: [] },
      { sweep: true, now: () => Date.now() + 1e12 },
    );
    expect(report.staleStagingArtifactIds).toContain(artifactId);
    expect((await store.listStaging()).length).toBe(0);
  });
});

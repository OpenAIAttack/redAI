/**
 * Live-PostgreSQL integration tests for the DB-backed artifacts repository + service,
 * paired with a real LocalObjectStore on a throwaway temp dir. These prove the durable
 * upload lifecycle against real PG16:
 *
 *  - an artifact reaches `ready` ONLY once verified bytes are present (INV-007);
 *  - a hash mismatch leaves the row `pending` (never a partial `ready`);
 *  - a duplicate finalize is idempotent (no double-ready) and the finalized payload is
 *    immutable (the migration-0002 trigger);
 *  - a crash between the atomic rename and the DB commit leaves a non-public orphan that
 *    a retry finalize recovers, and that reconciliation sweeps once the row is gone;
 *  - a disk-full/IO publish failure leaves the row `pending`;
 *  - cross-project isolation: an artifact is invisible under a foreign project id.
 *
 * Self-contained throwaway-database harness (D09): imports package SOURCE by relative
 * path and skips LOUDLY when DATABASE_URL is unset.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase, insertBaseGraph, type TestDatabase } from './support.js';
import { LocalObjectStore } from '../../../packages/storage/src/index.js';
import {
  createDbArtifactsRepository,
  createDbProjectGate,
} from '../../../packages/application/src/artifacts/dbRepository.js';
import { ArtifactsService } from '../../../packages/application/src/artifacts/service.js';

const d = HAS_DB ? describe : describe.skip;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

class FixedClock {
  now(): Date {
    return new Date(1_700_000_000_000);
  }
}

d('artifacts DB repository + service (live PG16 + local ObjectStore)', () => {
  let db: TestDatabase;
  let root: string;
  let store: LocalObjectStore;
  let svc: ArtifactsService;
  let ws: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    const base = await insertBaseGraph(db.pool);
    ws = base.workspaceId;
    projectId = base.projectId;
    root = await mkdtemp(join(tmpdir(), 'redai-t07-db-'));
    store = new LocalObjectStore({ root });
    svc = new ArtifactsService({
      repo: createDbArtifactsRepository(db.pool),
      projects: createDbProjectGate(db.pool),
      store,
      clock: new FixedClock(),
    });
  });
  afterEach(async () => {
    await db.drop();
    await rm(root, { recursive: true, force: true });
  });

  async function upload(bytes: Buffer, mediaType: string): Promise<string> {
    const created = await svc.createUpload(ws, projectId, {
      filename: 'f.bin',
      mediaType,
      byteSize: bytes.length,
      sha256: sha256(bytes),
      classification: 'internal',
    });
    await svc.putContent(ws, projectId, created.id, bytes);
    return created.id;
  }

  it('reaches ready only with verified bytes, and stores the observed digest', async () => {
    const bytes = Buffer.from('durable evidence bytes');
    const id = await upload(bytes, 'text/plain');
    expect((await svc.getArtifact(ws, projectId, id)).status).toBe('pending');
    const ready = await svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length });
    expect(ready.status).toBe('ready');
    expect(ready.sha256).toBe(sha256(bytes));
    expect(ready.byteSize).toBe(bytes.length);
    // Bytes are actually present and downloadable.
    const dl = await svc.openDownload(ws, projectId, id);
    expect(dl.content.byteSize).toBe(bytes.length);
  });

  it('leaves the row pending on a hash mismatch (no partial ready)', async () => {
    const bytes = Buffer.from('real bytes');
    const id = await upload(bytes, 'text/plain');
    await expect(
      svc.finalize(ws, projectId, id, { sha256: 'a'.repeat(64), byteSize: bytes.length }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect((await svc.getArtifact(ws, projectId, id)).status).toBe('pending');
  });

  it('is idempotent on duplicate finalize and the finalized payload is immutable', async () => {
    const bytes = Buffer.from('finalize once');
    const id = await upload(bytes, 'text/plain');
    const first = await svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length });
    const second = await svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length });
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    // The DB immutability trigger rejects a payload overwrite of the finalized row.
    await expect(
      db.pool.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1`, [id, 'c'.repeat(64)]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('quarantines a media-type/bytes mismatch instead of publishing ready', async () => {
    const bytes = Buffer.from('this is plainly not a png');
    const id = await upload(bytes, 'image/png');
    await expect(
      svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length }),
    ).rejects.toMatchObject({ code: 'MEDIA_TYPE_MISMATCH' });
    expect((await svc.getArtifact(ws, projectId, id)).status).toBe('quarantined');
    await expect(svc.openDownload(ws, projectId, id)).rejects.toMatchObject({ code: 'CONTENT_NOT_READY' });
  });

  it('crash between rename and DB commit: no public orphan, retry recovers', async () => {
    const bytes = Buffer.from('committed to disk, not to DB');
    const id = await upload(bytes, 'text/plain');
    const key = (await svc.getArtifact(ws, projectId, id)).storageKey;
    // Simulate the crash: the STORE publishes the object (rename) but the DB commit never
    // happens (row stays pending).
    const outcome = await store.finalize({ artifactId: id, storageKey: key, declared: { sha256: sha256(bytes), byteSize: bytes.length }, mediaType: 'text/plain' });
    expect(outcome.ok).toBe(true);
    // The pending row is never served — no public orphan.
    await expect(svc.openDownload(ws, projectId, id)).rejects.toMatchObject({ code: 'CONTENT_NOT_READY' });
    // Reconcile keeps the object while the (pending) row still owns it.
    let report = await svc.reconcile(ws, { sweep: true });
    expect(report.orphanObjectKeys).toEqual([]);
    expect(await store.objectExists(key)).toBe(true);
    // A retry finalize recovers the already-published object and commits to ready.
    const recovered = await svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length });
    expect(recovered.status).toBe('ready');
    // Once ready, reconcile still keeps it and reports no orphan/missing.
    report = await svc.reconcile(ws, { sweep: true });
    expect(report.orphanObjectKeys).toEqual([]);
    expect(report.missingObjectKeys).toEqual([]);
  });

  it('reconcile sweeps a rowless orphan object (finalized file, purged row)', async () => {
    const bytes = Buffer.from('to be orphaned');
    const id = await upload(bytes, 'text/plain');
    const key = (await svc.getArtifact(ws, projectId, id)).storageKey;
    await store.finalize({ artifactId: id, storageKey: key, declared: { sha256: sha256(bytes), byteSize: bytes.length }, mediaType: 'text/plain' });
    // Purge the DB row (simulate a completed delete/purge) — the object is now rowless.
    await db.pool.query('DELETE FROM artifacts WHERE id = $1', [id]);
    const report = await svc.reconcile(ws, { sweep: true });
    expect(report.orphanObjectKeys).toEqual([key]);
    expect(await store.objectExists(key)).toBe(false);
  });

  it('surfaces a disk-full/IO publish failure as StorageIo and stays pending', async () => {
    const bytes = Buffer.from('x');
    const id = await upload(bytes, 'text/plain');
    // Block the publish: make the object key's parent a FILE so mkdir fails (ENOTDIR).
    const key = (await svc.getArtifact(ws, projectId, id)).storageKey;
    const wsSeg = key.split('/')[0]!;
    await mkdir(join(root, 'objects'), { recursive: true });
    await writeFile(join(root, 'objects', wsSeg), 'blocker');
    await expect(
      svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length }),
    ).rejects.toMatchObject({ code: 'STORAGE_IO' });
    expect((await svc.getArtifact(ws, projectId, id)).status).toBe('pending');
  });

  it('cross-project isolation: an artifact is invisible under a foreign project id', async () => {
    const bytes = Buffer.from('project-scoped');
    const id = await upload(bytes, 'text/plain');
    await svc.finalize(ws, projectId, id, { sha256: sha256(bytes), byteSize: bytes.length });
    // A second project in the same workspace.
    const other = await db.pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name) VALUES ($1, 'P2') RETURNING id`,
      [ws],
    );
    const otherProject = other.rows[0]!.id;
    await expect(svc.getArtifact(ws, otherProject, id)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    await expect(svc.openDownload(ws, otherProject, id)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
  });

  it('lists artifacts newest-first within a project only', async () => {
    const a = await upload(Buffer.from('one'), 'text/plain');
    const b = await upload(Buffer.from('two'), 'text/plain');
    await svc.finalize(ws, projectId, a, { sha256: sha256(Buffer.from('one')), byteSize: 3 });
    await svc.finalize(ws, projectId, b, { sha256: sha256(Buffer.from('two')), byteSize: 3 });
    const page = await svc.listArtifacts(ws, projectId, {});
    expect(page.items.map((i) => i.id)).toEqual([b, a]);
  });
});

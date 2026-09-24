/**
 * Unit tests for {@link ArtifactsService} over the in-memory repository + a real
 * {@link LocalObjectStore} on a throwaway temp dir. These prove the use-case logic
 * end-to-end without a database: verified-only `ready`, hash mismatch, interrupted
 * upload, idempotent finalize (no double-ready), media-type quarantine, cross-project
 * isolation, disk-full handling, safe preview and reconciliation.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalObjectStore,
  StorageError,
  type FinalizeParams,
  type ObjectStore,
} from '@redai/storage';
import { InMemoryArtifactsRepository, InMemoryProjectGate } from './memoryRepository.js';
import { ArtifactsService } from './service.js';
import {
  ArtifactNotFoundError,
  ContentNotReadyError,
  HashMismatchError,
  MediaTypeMismatchError,
  ProjectNotActiveError,
  SizeExceededError,
  StorageIoError,
} from './errors.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROJECT_A = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PROJECT_B = 'dddddddd-4444-4444-8444-dddddddddddd';

class FixedClock {
  now(): Date {
    return new Date(1_700_000_000_000);
  }
}
class SeqUuid {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let root: string;
let store: LocalObjectStore;
let repo: InMemoryArtifactsRepository;
let gate: InMemoryProjectGate;
let svc: ArtifactsService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'redai-artifacts-'));
  store = new LocalObjectStore({ root });
  repo = new InMemoryArtifactsRepository(new FixedClock());
  gate = new InMemoryProjectGate();
  gate.set(WS, PROJECT_A, 'active');
  gate.set(WS, PROJECT_B, 'active');
  svc = new ArtifactsService({
    repo,
    store,
    projects: gate,
    clock: new FixedClock(),
    random: new SeqUuid(),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fullUpload(bytes: Buffer, mediaType: string, classification = 'internal' as const) {
  const created = await svc.createUpload(WS, PROJECT_A, {
    filename: 'f',
    mediaType,
    byteSize: bytes.length,
    sha256: sha256(bytes),
    classification,
  });
  await svc.putContent(WS, PROJECT_A, created.id, bytes);
  return created;
}

describe('ArtifactsService', () => {
  it('createUpload → putContent → finalize reaches ready ONLY with verified bytes', async () => {
    const bytes = Buffer.from('evidence bytes');
    const created = await fullUpload(bytes, 'text/plain');
    expect(created.status).toBe('pending');
    const ready = await svc.finalize(WS, PROJECT_A, created.id, {
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    expect(ready.status).toBe('ready');
    expect(ready.readyAt).not.toBeNull();
    // The bytes are downloadable.
    const dl = await svc.openDownload(WS, PROJECT_A, created.id);
    expect(dl.content.byteSize).toBe(bytes.length);
  });

  it('rejects a finalize whose declared digest differs from what was recorded', async () => {
    const bytes = Buffer.from('abc');
    const created = await fullUpload(bytes, 'text/plain');
    await expect(
      svc.finalize(WS, PROJECT_A, created.id, { sha256: 'a'.repeat(64), byteSize: bytes.length }),
    ).rejects.toBeInstanceOf(HashMismatchError);
    const row = await svc.getArtifact(WS, PROJECT_A, created.id);
    expect(row.status).toBe('pending'); // never became ready
  });

  it('rejects a finalize when the uploaded bytes were interrupted (fewer than declared)', async () => {
    const declared = Buffer.from('the full evidence payload');
    const created = await svc.createUpload(WS, PROJECT_A, {
      filename: 'f',
      mediaType: 'text/plain',
      byteSize: declared.length,
      sha256: sha256(declared),
      classification: 'internal',
    });
    // Only a truncated prefix actually arrives.
    await svc.putContent(WS, PROJECT_A, created.id, Buffer.from('the full'));
    await expect(
      svc.finalize(WS, PROJECT_A, created.id, {
        sha256: sha256(declared),
        byteSize: declared.length,
      }),
    ).rejects.toBeInstanceOf(HashMismatchError);
    expect((await svc.getArtifact(WS, PROJECT_A, created.id)).status).toBe('pending');
  });

  it('is idempotent on a duplicate finalize (no double-ready)', async () => {
    const bytes = Buffer.from('once');
    const created = await fullUpload(bytes, 'text/plain');
    const first = await svc.finalize(WS, PROJECT_A, created.id, {
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    const second = await svc.finalize(WS, PROJECT_A, created.id, {
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(second.readyAt?.getTime()).toBe(first.readyAt?.getTime());
  });

  it('quarantines a media-type/bytes mismatch instead of publishing ready', async () => {
    const bytes = Buffer.from('this is not a png');
    const created = await fullUpload(bytes, 'image/png');
    await expect(
      svc.finalize(WS, PROJECT_A, created.id, { sha256: sha256(bytes), byteSize: bytes.length }),
    ).rejects.toBeInstanceOf(MediaTypeMismatchError);
    expect((await svc.getArtifact(WS, PROJECT_A, created.id)).status).toBe('quarantined');
    // A quarantined artifact never serves bytes.
    await expect(svc.openDownload(WS, PROJECT_A, created.id)).rejects.toBeInstanceOf(
      ContentNotReadyError,
    );
  });

  it('enforces the upload byte cap at createUpload', async () => {
    await expect(
      svc.createUpload(WS, PROJECT_A, {
        filename: 'big',
        mediaType: 'text/plain',
        byteSize: 26_214_401,
        sha256: 'a'.repeat(64),
        classification: 'internal',
      }),
    ).rejects.toBeInstanceOf(SizeExceededError);
  });

  it('refuses uploads to a non-active project', async () => {
    gate.set(WS, PROJECT_A, 'archived');
    await expect(
      svc.createUpload(WS, PROJECT_A, {
        filename: 'f',
        mediaType: 'text/plain',
        byteSize: 1,
        sha256: 'a'.repeat(64),
        classification: 'internal',
      }),
    ).rejects.toBeInstanceOf(ProjectNotActiveError);
  });

  it('cross-project isolation: an artifact created in A is not visible under B', async () => {
    const bytes = Buffer.from('secret A');
    const created = await fullUpload(bytes, 'text/plain');
    await svc.finalize(WS, PROJECT_A, created.id, {
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    await expect(svc.getArtifact(WS, PROJECT_B, created.id)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(svc.openDownload(WS, PROJECT_B, created.id)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(svc.preview(WS, PROJECT_B, created.id)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });

  it('surfaces a disk-full/IO publish failure as StorageIo and never marks ready', async () => {
    const bytes = Buffer.from('x');
    const created = await fullUpload(bytes, 'text/plain');
    // A store whose publish always fails (ENOSPC-class).
    const faulty: ObjectStore = {
      writeStaging: store.writeStaging.bind(store),
      openRead: store.openRead.bind(store),
      readBounded: store.readBounded.bind(store),
      objectExists: store.objectExists.bind(store),
      removeObject: store.removeObject.bind(store),
      removeStaging: store.removeStaging.bind(store),
      listObjectKeys: store.listObjectKeys.bind(store),
      listStaging: store.listStaging.bind(store),
      finalize: (_p: FinalizeParams) =>
        Promise.reject(new StorageError('WRITE_FAILED', 'no space left on device', 'ENOSPC')),
    };
    const faultySvc = new ArtifactsService({
      repo,
      store: faulty,
      projects: gate,
      clock: new FixedClock(),
      random: new SeqUuid(),
    });
    await expect(
      faultySvc.finalize(WS, PROJECT_A, created.id, {
        sha256: sha256(bytes),
        byteSize: bytes.length,
      }),
    ).rejects.toBeInstanceOf(StorageIoError);
    expect((await svc.getArtifact(WS, PROJECT_A, created.id)).status).toBe('pending');
  });

  it('builds a safe, HTML-escaped preview for ready text', async () => {
    const bytes = Buffer.from('<script>alert(1)</script>');
    const created = await fullUpload(bytes, 'text/markdown');
    await svc.finalize(WS, PROJECT_A, created.id, {
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    const { preview } = await svc.preview(WS, PROJECT_A, created.id);
    expect(preview.kind).toBe('text');
    if (preview.kind === 'text') expect(preview.content).not.toContain('<script>');
  });

  it('reconcile sweeps an orphan object (finalized file, row never ready)', async () => {
    // Simulate a crash between rename and DB commit: publish bytes to the store but keep
    // the row pending (no markReady). The download stays not-ready (no public orphan).
    const bytes = Buffer.from('orphan bytes');
    const created = await svc.createUpload(WS, PROJECT_A, {
      filename: 'f',
      mediaType: 'text/plain',
      byteSize: bytes.length,
      sha256: sha256(bytes),
      classification: 'internal',
    });
    await svc.putContent(WS, PROJECT_A, created.id, bytes);
    // Directly finalize in the STORE only (rename happens) but do not touch the repo.
    const outcome = await store.finalize({
      artifactId: created.id,
      storageKey: created.storageKey,
      declared: { sha256: sha256(bytes), byteSize: bytes.length },
      mediaType: 'text/plain',
    });
    expect(outcome.ok).toBe(true);
    // The row is still pending → not served.
    await expect(svc.openDownload(WS, PROJECT_A, created.id)).rejects.toBeInstanceOf(
      ContentNotReadyError,
    );
    // Reconcile: pending row keeps its object (may be finalizing); it is NOT an orphan yet.
    let report = await svc.reconcile(WS, { sweep: true });
    expect(report.orphanObjectKeys).toEqual([]);
    expect(await store.objectExists(created.storageKey)).toBe(true);
    // Now the row is quarantined/abandoned → still "live non-ready", still kept. Only a
    // truly rowless object is an orphan: delete the row to simulate a purge, then sweep.
    (repo as unknown as { artifacts: Map<string, unknown> }).artifacts.delete(created.id);
    report = await svc.reconcile(WS, { sweep: true });
    expect(report.orphanObjectKeys).toEqual([created.storageKey]);
    expect(await store.objectExists(created.storageKey)).toBe(false);
  });
});

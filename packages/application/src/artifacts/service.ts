/**
 * Artifact use cases (T07): staged upload → server-verified finalize → authenticated
 * download and safe preview, with reconciliation.
 *
 * The lifecycle is a durable state machine over the DB row plus the ObjectStore bytes:
 *
 *   createUpload  → row `pending`, logical storage_key reserved, no bytes yet
 *   putContent    → bytes streamed into the store's staging area (still `pending`)
 *   finalize      → server computes sha256+size over the OBSERVED bytes, verifies them
 *                   against the client-declared values, atomically renames staging →
 *                   objects/<key>, then commits the row to `ready` (or `quarantined`
 *                   when the bytes contradict the declared media type)
 *
 * INV-007: a `ready` artifact's payload is immutable — the DB trigger enforces it and
 * `markReady` only ever fires from `pending`, so a double finalize cannot re-publish.
 * A `ready` row exists ONLY once verified bytes are present. A crash between the rename
 * and the commit leaves an orphan file that is never served (download requires `ready`)
 * and is cleaned by {@link ArtifactsService.reconcile}. Cross-project isolation is
 * structural: every method threads `(workspaceId, projectId, artifactId)` so a foreign
 * id resolves to NotFound (INV-001).
 */
import {
  LocalObjectStore,
  StorageError,
  buildPreview,
  isStorageError,
  logicalStorageKey,
  reconcile,
  type ObjectStore,
  type Preview,
  type ReadHandle,
  type ReconcileReport,
} from '@redai/storage';
import { cryptoRandom, systemClock } from '../auth/crypto.js';
import { decodeCursor } from './cursor.js';
import {
  ArtifactNotFoundError,
  ArtifactNotPendingError,
  ContentNotReadyError,
  HashMismatchError,
  MediaTypeMismatchError,
  PreviewUnsupportedError,
  ProjectNotActiveError,
  ProjectNotFoundError,
  SizeExceededError,
  StorageIoError,
  UploadNotStagedError,
} from './errors.js';
import type {
  ArtifactRecord,
  ArtifactsRepository,
  Classification,
  Clock,
  Page,
  PageQuery,
  ProjectGate,
  RandomSource,
} from './ports.js';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
/** SPEC_LOCK.defaults.upload_max_bytes / preview_max_bytes. */
export const UPLOAD_MAX_BYTES = 26_214_400;
export const PREVIEW_MAX_BYTES = 1_048_576;

export interface ArtifactsServiceDeps {
  repo: ArtifactsRepository;
  store: ObjectStore;
  projects: ProjectGate;
  clock?: Clock;
  random?: RandomSource;
  uploadMaxBytes?: number;
  previewMaxBytes?: number;
  defaultPageLimit?: number;
  maxPageLimit?: number;
}

export interface CreateUploadInput {
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  classification: Classification;
  kind?: string | undefined;
  sourceRunId?: string | undefined;
}

export interface DownloadHandle {
  record: ArtifactRecord;
  content: ReadHandle;
}

function normalizePage(
  requested: number | undefined,
  def: number,
  max: number,
  cursor: string | undefined,
): PageQuery {
  const limit = Math.min(max, Math.max(1, Math.trunc(requested ?? def)));
  const clean = decodeCursor(cursor) ? cursor : undefined;
  return { limit, ...(clean !== undefined ? { cursor: clean } : {}) };
}

export class ArtifactsService {
  private readonly repo: ArtifactsRepository;
  private readonly store: ObjectStore;
  private readonly projects: ProjectGate;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly uploadMax: number;
  private readonly previewMax: number;
  private readonly def: number;
  private readonly max: number;

  public constructor(deps: ArtifactsServiceDeps) {
    this.repo = deps.repo;
    this.store = deps.store;
    this.projects = deps.projects;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? cryptoRandom;
    this.uploadMax = deps.uploadMaxBytes ?? UPLOAD_MAX_BYTES;
    this.previewMax = deps.previewMaxBytes ?? PREVIEW_MAX_BYTES;
    this.def = deps.defaultPageLimit ?? DEFAULT_PAGE_LIMIT;
    this.max = deps.maxPageLimit ?? MAX_PAGE_LIMIT;
  }

  private async requireActiveProject(workspaceId: string, projectId: string): Promise<void> {
    const status = await this.projects.status(workspaceId, projectId);
    if (status === null) throw new ProjectNotFoundError();
    if (status !== 'active') throw new ProjectNotActiveError();
  }

  private async requireProject(workspaceId: string, projectId: string): Promise<void> {
    const status = await this.projects.status(workspaceId, projectId);
    if (status === null) throw new ProjectNotFoundError();
  }

  /** Create a `pending` artifact and reserve its logical storage key. No bytes yet. */
  async createUpload(
    workspaceId: string,
    projectId: string,
    input: CreateUploadInput,
  ): Promise<ArtifactRecord> {
    await this.requireActiveProject(workspaceId, projectId);
    if (input.byteSize > this.uploadMax) throw new SizeExceededError();
    const id = this.random.uuid();
    const storageKey = logicalStorageKey(workspaceId, projectId, id);
    return this.repo.createArtifact(workspaceId, projectId, id, storageKey, {
      filename: input.filename,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      classification: input.classification,
      kind: input.kind ?? 'upload',
      ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    });
  }

  async getArtifact(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> {
    const row = await this.repo.getArtifact(workspaceId, projectId, artifactId);
    if (!row) throw new ArtifactNotFoundError();
    return row;
  }

  async listArtifacts(
    workspaceId: string,
    projectId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ArtifactRecord>> {
    await this.requireProject(workspaceId, projectId);
    return this.repo.listArtifacts(
      workspaceId,
      projectId,
      normalizePage(opts.limit, this.def, this.max, opts.cursor),
    );
  }

  /**
   * Stream uploaded bytes into staging. Requires a `pending` artifact in this project.
   * The bytes are NOT trusted yet — verification happens at finalize.
   */
  async putContent(
    workspaceId: string,
    projectId: string,
    artifactId: string,
    data: Buffer | AsyncIterable<Buffer>,
  ): Promise<void> {
    const row = await this.getArtifact(workspaceId, projectId, artifactId);
    if (row.status !== 'pending') throw new ArtifactNotPendingError();
    try {
      await this.store.writeStaging(artifactId, data, { maxBytes: this.uploadMax });
    } catch (err) {
      throw this.mapStorageError(err);
    }
  }

  /**
   * Verify staged bytes against the declared digest/size, publish atomically, and commit
   * the row to `ready` (or `quarantined` on a media-type/bytes contradiction). Idempotent:
   * a repeat finalize of an already-ready/quarantined artifact returns the current row
   * without re-publishing (no double-ready). `declared` is the finalize body; it must
   * also agree with what `createUpload` recorded, so a client that changes its mind is a
   * mismatch.
   */
  async finalize(
    workspaceId: string,
    projectId: string,
    artifactId: string,
    declared: { sha256: string; byteSize: number },
  ): Promise<ArtifactRecord> {
    const row = await this.getArtifact(workspaceId, projectId, artifactId);
    if (row.status === 'ready' || row.status === 'quarantined') {
      // Idempotent replay: the state machine already reached a terminal upload state.
      return row;
    }
    if (row.status !== 'pending') throw new ArtifactNotPendingError();
    // The finalize body must agree with the row recorded at createUpload.
    if (declared.sha256 !== row.sha256 || declared.byteSize !== row.byteSize) {
      throw new HashMismatchError(row.sha256, declared.sha256);
    }

    let outcome;
    try {
      outcome = await this.store.finalize({
        artifactId,
        storageKey: row.storageKey,
        declared: { sha256: row.sha256, byteSize: row.byteSize },
        mediaType: row.mediaType,
      });
    } catch (err) {
      throw this.mapStorageError(err);
    }

    if (!outcome.ok) {
      if (outcome.reason === 'not-staged') throw new UploadNotStagedError();
      throw new HashMismatchError(row.sha256, outcome.observed.sha256);
    }

    if (outcome.contentMismatch) {
      const q = await this.repo.markQuarantined(workspaceId, projectId, artifactId);
      if (q === 'not-found') throw new ArtifactNotFoundError();
      // If a concurrent finalize already advanced the row, re-read for the current state.
      if (q === 'not-pending') return this.getArtifact(workspaceId, projectId, artifactId);
      throw new MediaTypeMismatchError();
    }

    const updated = await this.repo.markReady(workspaceId, projectId, artifactId, {
      sha256: outcome.sha256,
      byteSize: outcome.byteSize,
    });
    if (updated === 'not-found') throw new ArtifactNotFoundError();
    if (updated === 'not-pending') return this.getArtifact(workspaceId, projectId, artifactId);
    return updated;
  }

  /** Open verified bytes for download. Only a `ready` artifact is ever served (no orphan). */
  async openDownload(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<DownloadHandle> {
    const row = await this.getArtifact(workspaceId, projectId, artifactId);
    if (row.status !== 'ready') throw new ContentNotReadyError();
    try {
      const content = await this.store.openRead(row.storageKey);
      return { record: row, content };
    } catch (err) {
      throw this.mapStorageError(err);
    }
  }

  /**
   * Build a bounded, redacted, safe preview. Only a `ready` artifact previews. If the
   * bytes contradict the declared media type (defence in depth beyond finalize) the row
   * is quarantined and the request refused. Types we cannot render safely yield
   * PREVIEW_UNSUPPORTED (the owner can still download the bytes).
   */
  async preview(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<{ record: ArtifactRecord; preview: Preview }> {
    const row = await this.getArtifact(workspaceId, projectId, artifactId);
    if (row.status !== 'ready') throw new ContentNotReadyError();
    let bytes: Buffer;
    try {
      bytes = await this.store.readBounded(row.storageKey, this.previewMax);
    } catch (err) {
      throw this.mapStorageError(err);
    }
    const preview = buildPreview(row.mediaType, bytes, {
      complete: row.byteSize <= this.previewMax,
    });
    if (preview.kind === 'mismatch') {
      // A ready row whose bytes now contradict its type is quarantined; it stops serving.
      await this.repo.markQuarantined(workspaceId, projectId, artifactId).catch(() => undefined);
      throw new MediaTypeMismatchError();
    }
    if (preview.kind === 'unsupported') throw new PreviewUnsupportedError();
    return { record: row, preview };
  }

  /**
   * Reconcile DB rows against on-disk bytes for a workspace: sweep orphan objects (a
   * finalized file whose row never reached `ready`) and abandoned staging, and report
   * `ready` rows whose bytes went missing. Never exposes an orphan — it deletes it.
   */
  async reconcile(workspaceId: string, opts: { sweep?: boolean } = {}): Promise<ReconcileReport> {
    const { readyKeys, liveNonReadyKeys } = await this.repo.listStorageKeysByReadiness(workspaceId);
    return reconcile(
      this.store,
      { readyKeys, liveNonReadyKeys },
      { sweep: opts.sweep ?? false, now: () => this.clock.now().getTime() },
    );
  }

  private mapStorageError(err: unknown): Error {
    if (isStorageError(err)) {
      const e = err as StorageError;
      switch (e.code) {
        case 'SIZE_EXCEEDED':
          return new SizeExceededError();
        case 'NOT_FOUND':
          return new ContentNotReadyError();
        case 'HASH_MISMATCH':
          return new HashMismatchError('', '');
        case 'PATH_INVALID':
        case 'SYMLINK_REJECTED':
        case 'WRITE_FAILED':
        case 'READ_FAILED':
        case 'NOT_STAGED':
        default:
          return new StorageIoError();
      }
    }
    return err instanceof Error ? err : new StorageIoError();
  }
}

/** Compose the ObjectStore for production wiring from the configured root. */
export function createLocalObjectStore(root: string): ObjectStore {
  return new LocalObjectStore({ root });
}

/**
 * Injected collaborators and the storage port for the artifact use cases (T07).
 *
 * The service depends on a small {@link ArtifactsRepository} (DB metadata) and the
 * `ObjectStore` (bytes, from `@redai/storage`). Both are injected so the unit tests
 * drive an in-memory repository and a temp-dir store, and the DB adapter wires the real
 * `pg` pool. No `pg` / `@redai/db` type leaks across this boundary — records are
 * DB-shape-neutral (camelCase). Every read/write is scoped by `(workspaceId,
 * projectId, artifactId)` so an artifact addressed under the wrong project resolves to
 * NotFound, never a cross-project read (INV-001).
 */

export interface Clock {
  now(): Date;
}
export interface RandomSource {
  uuid(): string;
}

export type ProjectStatus = 'active' | 'archived' | 'deleting' | 'deleted';

/**
 * Read-only gate onto project status. Injected (rather than importing the projects
 * service) so the artifact use cases stay decoupled: they only need to know whether a
 * project exists in the workspace and is active enough to accept an upload.
 */
export interface ProjectGate {
  status(workspaceId: string, projectId: string): Promise<ProjectStatus | null>;
}

export type ArtifactStatus = 'pending' | 'ready' | 'quarantined' | 'deleting' | 'deleted';
export type Classification = 'public' | 'internal' | 'sensitive' | 'restricted';

export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  filename: string;
  mediaType: string;
  kind: string;
  /** byte_size (bigint) as a JS number; artifacts are bounded well below 2^53. */
  byteSize: number;
  sha256: string;
  storageKey: string;
  status: ArtifactStatus;
  classification: Classification;
  sourceRunId: string | null;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageQuery {
  limit: number;
  cursor?: string | undefined;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateArtifactFields {
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  classification: Classification;
  kind?: string | undefined;
  sourceRunId?: string | undefined;
}

/** Observed bytes after server verification, written onto the row at finalize. */
export interface VerifiedBytes {
  sha256: string;
  byteSize: number;
}

/**
 * Metadata store for artifacts. Byte content lives in the ObjectStore, not here.
 * `markReady`/`markQuarantined` are conditional on the row still being `pending` so a
 * concurrent finalize cannot double-publish (INV-007: a finalized payload is immutable).
 */
export interface ArtifactsRepository {
  createArtifact(
    workspaceId: string,
    projectId: string,
    id: string,
    storageKey: string,
    fields: CreateArtifactFields,
  ): Promise<ArtifactRecord>;
  getArtifact(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null>;
  listArtifacts(
    workspaceId: string,
    projectId: string,
    page: PageQuery,
  ): Promise<Page<ArtifactRecord>>;
  /** pending → ready, stamping observed bytes + ready_at. Only acts on a pending row. */
  markReady(
    workspaceId: string,
    projectId: string,
    artifactId: string,
    verified: VerifiedBytes,
  ): Promise<ArtifactRecord | 'not-found' | 'not-pending'>;
  /** pending → quarantined (a media-type/bytes contradiction). Only acts on a pending row. */
  markQuarantined(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | 'not-found' | 'not-pending'>;
  /**
   * Reconciliation inputs: the logical storage keys of ready rows, and of live
   * non-ready (pending/quarantined) rows, in this workspace. Scoped by workspace so the
   * maintenance job never crosses installations.
   */
  listStorageKeysByReadiness(
    workspaceId: string,
  ): Promise<{ readyKeys: string[]; liveNonReadyKeys: string[] }>;
}

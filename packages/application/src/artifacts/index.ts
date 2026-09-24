/**
 * @redai/application artifacts barrel — staged upload, server-verified finalize,
 * authenticated download, safe preview and reconciliation use cases.
 *
 * Exposed as the `@redai/application/artifacts` subpath export (D08) so its flat helper
 * names never collide with the other application modules. The API layer imports these
 * use cases; only the DB adapter reaches into `@redai/db`, and only the store adapter
 * reaches into `@redai/storage`.
 */

export {
  ArtifactsService,
  createLocalObjectStore,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  UPLOAD_MAX_BYTES,
  PREVIEW_MAX_BYTES,
} from './service.js';
export type { ArtifactsServiceDeps, CreateUploadInput, DownloadHandle } from './service.js';

export {
  ArtifactsError,
  ArtifactNotFoundError,
  ProjectNotFoundError,
  ProjectNotActiveError,
  ArtifactNotPendingError,
  UploadNotStagedError,
  HashMismatchError,
  SizeExceededError,
  ContentNotReadyError,
  MediaTypeMismatchError,
  PreviewUnsupportedError,
  StorageIoError,
} from './errors.js';
export type { ArtifactsErrorCode } from './errors.js';

export { createDbArtifactsRepository, createDbProjectGate } from './dbRepository.js';
export { InMemoryArtifactsRepository, InMemoryProjectGate } from './memoryRepository.js';

export { encodeCursor, decodeCursor } from './cursor.js';
export type { CursorKey } from './cursor.js';

export type {
  Clock,
  RandomSource,
  ProjectGate,
  ProjectStatus,
  ArtifactStatus,
  Classification,
  ArtifactRecord,
  CreateArtifactFields,
  VerifiedBytes,
  ArtifactsRepository,
  Page,
  PageQuery,
} from './ports.js';

// Re-export the storage preview + reconcile types the API layer serializes.
export type { Preview, ReconcileReport } from '@redai/storage';

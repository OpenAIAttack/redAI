/**
 * @redai/storage — local-filesystem ObjectStore with staged upload, server-side
 * checksum verification, atomic finalize, symlink/traversal-safe access, bounded safe
 * previews and reconciliation.
 *
 * Bytes live only under the configured root; the store speaks in LOGICAL keys and never
 * returns a host filesystem path (architecture §1: never expose host paths; §9: storage
 * behind a small interface). The application layer wires it to DB rows; the sandbox
 * never sees this store.
 */

export const STORAGE_PACKAGE = '@redai/storage';

export { StorageError, isStorageError, errnoOf } from './errors.js';
export type { StorageErrorCode } from './errors.js';

export { validateKey, resolveWithinRoot, assertNoSymlink } from './paths.js';

export { LocalObjectStore, logicalStorageKey } from './objectStore.js';
export type {
  ObjectStore,
  LocalObjectStoreOptions,
  DeclaredBytes,
  WriteStagingResult,
  FinalizeParams,
  FinalizeOutcome,
  ReadHandle,
  StagingEntry,
} from './objectStore.js';

export {
  previewClassFor,
  baseMediaType,
  sniffMismatch,
  parsePng,
  parseJpeg,
  looksLikeUtf8Text,
} from './sniff.js';
export type { PreviewClass, SniffResult, PngHeader, JpegHeader } from './sniff.js';

export { buildPreview, htmlEscape, redactSecrets } from './preview.js';
export type {
  Preview,
  PreviewOptions,
  TextPreview,
  CsvPreview,
  ImagePreview,
  UnsupportedPreview,
  MismatchPreview,
} from './preview.js';

export { reconcile } from './reconcile.js';
export type { DbArtifactView, ReconcileReport, ReconcileOptions } from './reconcile.js';

/**
 * Reconciliation between the DB's view of artifacts and the bytes on disk. DB and
 * filesystem are not one atomic system (docs/05 §"Finalize artifact"), so crashes
 * leave two classes of drift:
 *
 *  - ORPHAN OBJECT: a finalized file at a logical key whose DB row never reached
 *    `ready` (crash between the atomic rename and the DB commit). It is never served —
 *    downloads require a `ready` row — but it wastes space and must not linger.
 *  - MISSING OBJECT: a `ready` DB row whose bytes are absent. This is an integrity
 *    alarm: the row claims verified bytes that are gone.
 *  - STALE STAGING: an upload that was created and streamed but never finalized.
 *
 * This helper is pure over the two inputs (the DB-derived key sets and the store's disk
 * listing), so `@redai/storage` stays free of a DB dependency; the application layer
 * supplies the key sets and decides what to sweep.
 */
import type { ObjectStore } from './objectStore.js';

export interface DbArtifactView {
  /** Logical storage keys of rows currently in `ready` status. */
  readyKeys: Iterable<string>;
  /** Logical storage keys of rows in a non-ready, non-deleted status (pending/quarantined). */
  liveNonReadyKeys: Iterable<string>;
}

export interface ReconcileReport {
  /** Object files present on disk that no `ready` row claims (orphans; never public). */
  orphanObjectKeys: string[];
  /** `ready` rows whose object bytes are missing (integrity alarm). */
  missingObjectKeys: string[];
  /** Staging entries older than `staleStagingMs` (abandoned uploads). */
  staleStagingArtifactIds: string[];
}

export interface ReconcileOptions {
  /** Staging older than this many ms is considered abandoned (default 24h). */
  staleStagingMs?: number;
  /** When true, delete orphan objects and stale staging as they are found. */
  sweep?: boolean;
  now?: () => number;
}

/**
 * Compute (and optionally sweep) the drift between `db` and the store. Orphan objects
 * are only swept when they belong to NEITHER a ready nor a live non-ready row — a
 * pending row that is mid-finalize keeps its object. A missing object is reported but
 * never "fixed" here (only an operator/owner decides how to handle lost evidence).
 */
export async function reconcile(
  store: ObjectStore,
  db: DbArtifactView,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const staleMs = opts.staleStagingMs ?? 86_400_000;
  const now = opts.now ?? Date.now;
  const ready = new Set(db.readyKeys);
  const live = new Set(db.liveNonReadyKeys);

  const onDisk = await store.listObjectKeys();
  const orphanObjectKeys: string[] = [];
  for (const key of onDisk) {
    if (ready.has(key)) continue; // legitimately published
    if (live.has(key)) continue; // a pending row still owns this (may be finalizing)
    orphanObjectKeys.push(key);
  }

  const missingObjectKeys: string[] = [];
  const diskSet = new Set(onDisk);
  for (const key of ready) {
    if (!diskSet.has(key)) missingObjectKeys.push(key);
  }

  const staging = await store.listStaging();
  const staleStagingArtifactIds: string[] = [];
  for (const s of staging) {
    if (now() - s.mtimeMs > staleMs) staleStagingArtifactIds.push(s.artifactId);
  }

  if (opts.sweep) {
    for (const key of orphanObjectKeys) await store.removeObject(key);
    for (const id of staleStagingArtifactIds) await store.removeStaging(id);
  }

  return { orphanObjectKeys, missingObjectKeys, staleStagingArtifactIds };
}

/**
 * Injected collaborators and the storage port for the worker-identity use cases.
 *
 * Time and randomness sit behind the same tiny interfaces the auth module uses
 * (architecture §9), so unit tests drive a deterministic mock clock and a scripted
 * random source while production wires the real `node:crypto` implementations.
 *
 * The repository is DB-shape neutral: no `pg`/`@redai/db` type leaks across this
 * boundary. The DB adapter owns its own transaction boundaries; the in-memory fake
 * reproduces the same atomicity (the single-use enrollment critical section).
 */
import type { Clock, RandomSource } from '../auth/ports.js';

export type { Clock, RandomSource };

/** Worker lifecycle states mirrored from the `workers.state` CHECK constraint. */
export type WorkerState = 'online' | 'offline' | 'draining' | 'revoked' | 'unhealthy';

// --- storage records (DB-shape neutral) ---

export interface EnrollmentTokenRecord {
  id: string;
  workspaceId: string;
  tokenHash: Buffer;
  /** Owner-set defaults consumed at redemption (zone, display name, capacity). */
  workerDefaults: WorkerDefaults;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedWorkerId: string | null;
  createdAt: Date;
}

export interface WorkerDefaults {
  zone: string;
  displayName?: string;
  capacity?: number;
}

export interface WorkerRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  zone: string;
  capacity: number;
  state: WorkerState;
  agentVersion: string;
  manifestSha256: string;
  sessionId: string | null;
  sessionGeneration: string;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerCredentialRecord {
  id: string;
  workspaceId: string;
  workerId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** The joined credential + owning worker, as verification needs both. */
export interface CredentialWithWorker {
  credential: WorkerCredentialRecord;
  worker: WorkerRecord;
}

// --- write inputs ---

export interface CreateEnrollmentTokenInput {
  workspaceId: string;
  tokenHash: Buffer;
  workerDefaults: WorkerDefaults;
  expiresAt: Date;
}

export interface NewWorkerInput {
  /** Client-generated stable UUID; becomes the durable worker identity. */
  id: string;
  workspaceId: string;
  displayName: string;
  zone: string;
  capacity: number;
  agentVersion: string;
  manifestSha256: string;
}

export interface NewCredentialInput {
  workerId: string;
  workspaceId: string;
  tokenHash: Buffer;
  expiresAt: Date;
}

export interface RedeemEnrollmentInput {
  enrollmentTokenHash: Buffer;
  now: Date;
  worker: NewWorkerInput;
  credential: { tokenHash: Buffer; expiresAt: Date };
}

export interface RedeemEnrollmentOutcome {
  workerId: string;
  workspaceId: string;
  installationId: string;
  credentialId: string;
}

/**
 * Storage port for the worker-identity use cases. `redeemEnrollment` MUST be atomic
 * and single-use: it consumes the token, creates the worker and the first credential
 * in one transaction, and rejects a token already consumed or past its TTL. The DB
 * adapter uses `withTransaction` + a `FOR UPDATE` row lock; the in-memory fake keeps
 * the check-and-set in one synchronous critical section.
 */
export interface WorkerIdentityRepository {
  createEnrollmentToken(input: CreateEnrollmentTokenInput): Promise<EnrollmentTokenRecord>;

  /** Atomic redeem. Throws the typed enrollment errors on invalid/expired/consumed. */
  redeemEnrollment(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentOutcome>;

  /** Look up a live-or-not credential by its token hash, joined to its worker. */
  findCredentialByHash(tokenHash: Buffer): Promise<CredentialWithWorker | null>;

  getWorkerById(workerId: string): Promise<WorkerRecord | null>;

  createCredential(input: NewCredentialInput): Promise<WorkerCredentialRecord>;

  /**
   * Set `revoked_at` on one credential (idempotent: only while still NULL). Used for
   * an immediate revoke (now) and for the rotation overlap (a future instant that
   * keeps the retiring credential valid for the overlap window).
   */
  setCredentialRevokedAt(credentialId: string, revokedAt: Date): Promise<void>;

  /** Rotate: create the new credential and set the old one's overlap end atomically. */
  rotateCredential(input: {
    workerId: string;
    workspaceId: string;
    newCredential: { tokenHash: Buffer; expiresAt: Date };
    retiringOverlapUntil: Date;
  }): Promise<{ credentialId: string }>;

  /** Revoke the worker and all its credentials atomically (immediate). */
  revokeWorker(workerId: string, revokedAt: Date): Promise<void>;
}

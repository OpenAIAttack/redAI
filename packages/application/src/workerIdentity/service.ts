/**
 * Worker enrollment & identity use cases (docs/08 §§1–2, §11):
 *
 *  - Owner mints a one-use enrollment token (256-bit, TTL 10 min, stored hashed).
 *  - Worker redeems it exactly once before expiry, presenting its client-generated
 *    stable UUID + manifest; the server creates the worker identity and issues the
 *    first opaque worker credential (256-bit, TTL 30 days, stored ONLY as a hash).
 *  - The control plane verifies a presented credential in constant time.
 *  - The credential rotates with a bounded overlap (docs/08 §2: ≤5 min) and can be
 *    revoked immediately; revoking a worker revokes every credential it holds.
 *
 * Pure orchestration over injected ports (clock / random / repository); it opens no
 * sockets and reads no globals, so the unit tests drive it entirely with fakes.
 *
 * Secrets discipline: an enrollment token or worker credential plaintext exists only
 * as a method argument or as a single-use return value the caller must surface once.
 * Only hashes are handed to the repository, and no plaintext is logged or returned
 * after issuance (docs/08 §1: "no list/reveal credential").
 */
import { constantTimeEqual, cryptoRandom, hashToken, systemClock } from '../auth/crypto.js';
import {
  EnrollmentExpiredError,
  EnrollmentInvalidError,
  WorkerCredentialInvalidError,
  WorkerNotFoundError,
} from './errors.js';
import type { Clock, RandomSource, WorkerIdentityRepository, WorkerRecord } from './ports.js';

/** SPEC_LOCK enrollment_ttl_seconds = 600 (10 minutes). */
export const ENROLLMENT_TTL_MS = 600 * 1000;
/** SPEC_LOCK worker_credential_ttl_seconds = 2_592_000 (30 days). */
export const WORKER_CREDENTIAL_TTL_MS = 2_592_000 * 1000;
/** docs/08 §2: rotation overlap "tối đa 5 phút" — the retiring credential stays valid this long. */
export const CREDENTIAL_ROTATION_OVERLAP_MS = 5 * 60 * 1000;
/** Opaque-token entropy: 32 bytes = 256 bits (docs/08 §2). */
const TOKEN_BYTES = 32;
const DEFAULT_CAPACITY = 2;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;

export interface WorkerIdentityServiceDeps {
  repo: WorkerIdentityRepository;
  clock?: Clock;
  random?: RandomSource;
  enrollmentTtlMs?: number;
  credentialTtlMs?: number;
  rotationOverlapMs?: number;
}

export interface CreateEnrollmentTokenInput {
  workspaceId: string;
  zone: string;
  displayName?: string;
  capacity?: number;
}

export interface CreateEnrollmentTokenResult {
  enrollmentTokenId: string;
  /** Shown to the owner exactly once; only its hash is stored. */
  enrollmentToken: string;
  zone: string;
  expiresAt: Date;
}

export interface RedeemEnrollmentInput {
  enrollmentToken: string;
  /** Client-generated stable UUID; persists as the worker identity across restarts. */
  workerId: string;
  displayName: string;
  arch: string;
  agentVersion: string;
  manifestSha256: string;
  capacity?: number;
}

export interface RedeemEnrollmentResult {
  workerId: string;
  workspaceId: string;
  installationId: string;
  /** The one-time opaque credential; only its hash is stored. */
  workerCredential: string;
  credentialId: string;
  credentialExpiresAt: Date;
}

export interface WorkerAuthContext {
  workerId: string;
  workspaceId: string;
  credentialId: string;
  zone: string;
  state: WorkerRecord['state'];
}

export interface RotateCredentialResult {
  /** The new opaque credential; only its hash is stored. */
  workerCredential: string;
  credentialId: string;
  expiresAt: Date;
  /** The retiring credential remains valid until this instant (overlap window). */
  oldCredentialValidUntil: Date;
}

function clampCapacity(capacity: number | undefined): number {
  if (typeof capacity !== 'number' || !Number.isFinite(capacity)) return DEFAULT_CAPACITY;
  const truncated = Math.trunc(capacity);
  if (truncated < MIN_CAPACITY) return MIN_CAPACITY;
  if (truncated > MAX_CAPACITY) return MAX_CAPACITY;
  return truncated;
}

export class WorkerIdentityService {
  private readonly repo: WorkerIdentityRepository;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly enrollmentTtlMs: number;
  private readonly credentialTtlMs: number;
  private readonly rotationOverlapMs: number;

  public constructor(deps: WorkerIdentityServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? cryptoRandom;
    this.enrollmentTtlMs = deps.enrollmentTtlMs ?? ENROLLMENT_TTL_MS;
    this.credentialTtlMs = deps.credentialTtlMs ?? WORKER_CREDENTIAL_TTL_MS;
    this.rotationOverlapMs = deps.rotationOverlapMs ?? CREDENTIAL_ROTATION_OVERLAP_MS;
  }

  /** Owner-only: mint a one-use enrollment token bound to a workspace + zone. */
  async createEnrollmentToken(
    input: CreateEnrollmentTokenInput,
  ): Promise<CreateEnrollmentTokenResult> {
    const token = this.random.token(TOKEN_BYTES);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.enrollmentTtlMs);
    const record = await this.repo.createEnrollmentToken({
      workspaceId: input.workspaceId,
      tokenHash: hashToken(token),
      workerDefaults: {
        zone: input.zone,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.capacity !== undefined ? { capacity: clampCapacity(input.capacity) } : {}),
      },
      expiresAt,
    });
    return {
      enrollmentTokenId: record.id,
      enrollmentToken: token,
      zone: input.zone,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Worker-only: redeem an enrollment token exactly once and receive a durable
   * identity plus the first credential. The repository enforces single-use and TTL
   * atomically, so two concurrent redemptions of the same token yield exactly one
   * worker (the loser sees {@link EnrollmentAlreadyConsumedError}).
   */
  async redeemEnrollment(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentResult> {
    const now = this.clock.now();
    const credential = this.random.token(TOKEN_BYTES);
    const credentialExpiresAt = new Date(now.getTime() + this.credentialTtlMs);

    const outcome = await this.repo.redeemEnrollment({
      enrollmentTokenHash: hashToken(input.enrollmentToken),
      now,
      worker: {
        id: input.workerId,
        workspaceId: '', // filled by the repo from the token's workspace
        displayName: input.displayName,
        zone: '', // filled by the repo from the token's worker_defaults
        capacity: clampCapacity(input.capacity),
        agentVersion: input.agentVersion,
        manifestSha256: input.manifestSha256,
      },
      credential: { tokenHash: hashToken(credential), expiresAt: credentialExpiresAt },
    });

    return {
      workerId: outcome.workerId,
      workspaceId: outcome.workspaceId,
      installationId: outcome.installationId,
      workerCredential: credential,
      credentialId: outcome.credentialId,
      credentialExpiresAt,
    };
  }

  /**
   * Verify a presented worker bearer credential in constant time. Throws
   * {@link WorkerCredentialInvalidError} when the credential is unknown, expired,
   * revoked, or its worker is revoked — the failure never says which, so a caller
   * cannot distinguish an expired credential from a wrong one.
   */
  async verifyCredential(rawToken: string): Promise<WorkerAuthContext> {
    const presentedHash = hashToken(rawToken);
    const found = await this.repo.findCredentialByHash(presentedHash);
    if (!found) throw new WorkerCredentialInvalidError();

    // Defense in depth: the row was fetched by hash equality, but compare the hash
    // bytes in constant time so the verify path spends the same time regardless.
    if (!constantTimeEqual(presentedHash, found.credential.tokenHash)) {
      throw new WorkerCredentialInvalidError();
    }

    const now = this.clock.now();
    const { credential, worker } = found;
    if (credential.revokedAt !== null && now.getTime() >= credential.revokedAt.getTime()) {
      throw new WorkerCredentialInvalidError();
    }
    if (now.getTime() >= credential.expiresAt.getTime()) {
      throw new WorkerCredentialInvalidError();
    }
    if (worker.state === 'revoked' || worker.revokedAt !== null) {
      throw new WorkerCredentialInvalidError();
    }

    return {
      workerId: worker.id,
      workspaceId: worker.workspaceId,
      credentialId: credential.id,
      zone: worker.zone,
      state: worker.state,
    };
  }

  /**
   * Rotate a worker's credential with a bounded overlap. The retiring credential
   * (identified by the presenting context) stays valid for `rotationOverlapMs`, so a
   * daemon can swap without a gap; after the overlap only the new credential works.
   */
  async rotateCredential(context: {
    workerId: string;
    workspaceId: string;
    credentialId: string;
  }): Promise<RotateCredentialResult> {
    const now = this.clock.now();
    const newCredential = this.random.token(TOKEN_BYTES);
    const expiresAt = new Date(now.getTime() + this.credentialTtlMs);
    const oldCredentialValidUntil = new Date(now.getTime() + this.rotationOverlapMs);

    const { credentialId } = await this.repo.rotateCredential({
      workerId: context.workerId,
      workspaceId: context.workspaceId,
      newCredential: { tokenHash: hashToken(newCredential), expiresAt },
      retiringOverlapUntil: oldCredentialValidUntil,
    });

    // The presenting credential begins its overlap countdown now.
    await this.repo.setCredentialRevokedAt(context.credentialId, oldCredentialValidUntil);

    return {
      workerCredential: newCredential,
      credentialId,
      expiresAt,
      oldCredentialValidUntil,
    };
  }

  /** Revoke a single credential immediately (idempotent). */
  async revokeCredential(credentialId: string): Promise<void> {
    await this.repo.setCredentialRevokedAt(credentialId, this.clock.now());
  }

  /** Owner-only: revoke a worker and every credential it holds, immediately. */
  async revokeWorker(workerId: string): Promise<void> {
    const worker = await this.repo.getWorkerById(workerId);
    if (!worker) throw new WorkerNotFoundError();
    await this.repo.revokeWorker(workerId, this.clock.now());
  }

  /** Read a worker's public identity metadata (heartbeat/doctor surface). */
  async getWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.repo.getWorkerById(workerId);
    if (!worker) throw new WorkerNotFoundError();
    return worker;
  }
}

export { EnrollmentInvalidError, EnrollmentExpiredError };

/**
 * In-memory {@link WorkerIdentityRepository} for unit tests and DB-free local wiring.
 * It mirrors the DB adapter's contract, including the single-use enrollment critical
 * section: `redeemEnrollment` performs its check-and-set with no `await` between the
 * read and the write, the in-process analogue of the DB's `FOR UPDATE` row lock plus
 * the `WHERE consumed_at IS NULL` guard, so two concurrent redemptions of the same
 * token can never both create a worker.
 */
import { randomUUID } from 'node:crypto';
import {
  EnrollmentAlreadyConsumedError,
  EnrollmentExpiredError,
  EnrollmentInvalidError,
} from './errors.js';
import type {
  CreateEnrollmentTokenInput,
  CredentialWithWorker,
  EnrollmentTokenRecord,
  NewCredentialInput,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome,
  WorkerCredentialRecord,
  WorkerIdentityRepository,
  WorkerRecord,
} from './ports.js';

export class InMemoryWorkerIdentityRepository implements WorkerIdentityRepository {
  private readonly tokens = new Map<string, EnrollmentTokenRecord>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly credentials = new Map<string, WorkerCredentialRecord>();
  /** workspaceId -> installation_id, so redeem can echo it (as the DB join does). */
  private readonly installations = new Map<string, string>();

  /** Test helper: pin a workspace's installation id (else one is generated on demand). */
  seedWorkspaceInstallation(workspaceId: string, installationId: string): void {
    this.installations.set(workspaceId, installationId);
  }

  private installationFor(workspaceId: string): string {
    let id = this.installations.get(workspaceId);
    if (!id) {
      id = randomUUID();
      this.installations.set(workspaceId, id);
    }
    return id;
  }

  createEnrollmentToken(input: CreateEnrollmentTokenInput): Promise<EnrollmentTokenRecord> {
    const record: EnrollmentTokenRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      tokenHash: input.tokenHash,
      workerDefaults: input.workerDefaults,
      expiresAt: input.expiresAt,
      consumedAt: null,
      consumedWorkerId: null,
      createdAt: new Date(),
    };
    this.tokens.set(record.id, record);
    return Promise.resolve({ ...record });
  }

  redeemEnrollment(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentOutcome> {
    const hex = input.enrollmentTokenHash.toString('hex');
    const token = this.findTokenByHashHex(hex);
    // --- critical section: no `await` from here to the writes below ---
    if (!token) return Promise.reject(new EnrollmentInvalidError());
    if (token.consumedAt !== null) return Promise.reject(new EnrollmentAlreadyConsumedError());
    if (input.now.getTime() >= token.expiresAt.getTime()) {
      return Promise.reject(new EnrollmentExpiredError());
    }

    const now = new Date();
    const worker: WorkerRecord = {
      id: input.worker.id,
      workspaceId: token.workspaceId,
      displayName: input.worker.displayName || token.workerDefaults.displayName || 'worker',
      zone: token.workerDefaults.zone,
      capacity: input.worker.capacity,
      state: 'offline',
      agentVersion: input.worker.agentVersion,
      manifestSha256: input.worker.manifestSha256,
      sessionId: null,
      sessionGeneration: '0',
      lastSeenAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (this.workers.has(worker.id)) {
      // Same guarantee as the DB PK: a duplicate worker id is a hard conflict.
      return Promise.reject(new EnrollmentInvalidError());
    }
    this.workers.set(worker.id, worker);

    const credential: WorkerCredentialRecord = {
      id: randomUUID(),
      workspaceId: token.workspaceId,
      workerId: worker.id,
      tokenHash: input.credential.tokenHash,
      expiresAt: input.credential.expiresAt,
      revokedAt: null,
      createdAt: now,
    };
    this.credentials.set(credential.id, credential);

    token.consumedAt = input.now;
    token.consumedWorkerId = worker.id;

    return Promise.resolve({
      workerId: worker.id,
      workspaceId: token.workspaceId,
      installationId: this.installationFor(token.workspaceId),
      credentialId: credential.id,
    });
  }

  findCredentialByHash(tokenHash: Buffer): Promise<CredentialWithWorker | null> {
    const hex = tokenHash.toString('hex');
    for (const credential of this.credentials.values()) {
      if (credential.tokenHash.toString('hex') === hex) {
        const worker = this.workers.get(credential.workerId);
        if (!worker) return Promise.resolve(null);
        return Promise.resolve({ credential: { ...credential }, worker: { ...worker } });
      }
    }
    return Promise.resolve(null);
  }

  getWorkerById(workerId: string): Promise<WorkerRecord | null> {
    const worker = this.workers.get(workerId);
    return Promise.resolve(worker ? { ...worker } : null);
  }

  createCredential(input: NewCredentialInput): Promise<WorkerCredentialRecord> {
    const credential: WorkerCredentialRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.credentials.set(credential.id, credential);
    return Promise.resolve({ ...credential });
  }

  setCredentialRevokedAt(credentialId: string, revokedAt: Date): Promise<void> {
    const credential = this.credentials.get(credentialId);
    if (credential && credential.revokedAt === null) credential.revokedAt = revokedAt;
    return Promise.resolve();
  }

  rotateCredential(input: {
    workerId: string;
    workspaceId: string;
    newCredential: { tokenHash: Buffer; expiresAt: Date };
    retiringOverlapUntil: Date;
  }): Promise<{ credentialId: string }> {
    const credential: WorkerCredentialRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      tokenHash: input.newCredential.tokenHash,
      expiresAt: input.newCredential.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.credentials.set(credential.id, credential);
    return Promise.resolve({ credentialId: credential.id });
  }

  revokeWorker(workerId: string, revokedAt: Date): Promise<void> {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.state = 'revoked';
      worker.revokedAt = revokedAt;
      worker.updatedAt = revokedAt;
    }
    for (const credential of this.credentials.values()) {
      if (credential.workerId === workerId && credential.revokedAt === null) {
        credential.revokedAt = revokedAt;
      }
    }
    return Promise.resolve();
  }

  private findTokenByHashHex(hex: string): EnrollmentTokenRecord | null {
    for (const token of this.tokens.values()) {
      if (token.tokenHash.toString('hex') === hex) return token;
    }
    return null;
  }
}

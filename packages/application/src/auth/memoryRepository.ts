import { InvalidCredentialsError } from './errors.js';
/**
 * In-memory {@link AuthRepository} for tests and local wiring without a database.
 * It mirrors the DB adapter's contract, including the single-owner invariant: a
 * second `bootstrap` (even from a concurrently-scheduled promise) throws
 * {@link OwnerExistsError}, because the owner check-and-set runs with no `await`
 * between the read and the write — the in-process analogue of the DB's singleton
 * unique constraint.
 */
import { randomUUID } from 'node:crypto';
import { OwnerExistsError } from './errors.js';
import type {
  AuthRepository,
  BootstrapInput,
  BootstrapResult,
  CreateSessionRecord,
  OwnerRecord,
  SessionRecord,
} from './ports.js';

interface StoredSession extends SessionRecord {
  tokenHashHex: string;
}

export class InMemoryAuthRepository implements AuthRepository {
  private owner: OwnerRecord | null = null;
  private readonly sessions = new Map<string, StoredSession>();

  countOwners(): Promise<number> {
    return Promise.resolve(this.owner ? 1 : 0);
  }

  getOwnerByUsername(username: string): Promise<OwnerRecord | null> {
    return Promise.resolve(
      this.owner && this.owner.username === username ? { ...this.owner } : null,
    );
  }

  getOwnerById(id: string): Promise<OwnerRecord | null> {
    return Promise.resolve(this.owner && this.owner.id === id ? { ...this.owner } : null);
  }

  getSingletonOwner(): Promise<OwnerRecord | null> {
    return Promise.resolve(this.owner ? { ...this.owner } : null);
  }

  bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    // Critical section: no `await` between the check and the set.
    if (this.owner) return Promise.reject(new OwnerExistsError());
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    this.owner = {
      id: ownerId,
      workspaceId,
      username: input.username,
      passwordHash: input.passwordHash,
      recoveryCodeHash: input.recoveryCodeHash,
      passwordChangedAt: new Date(),
    };
    return Promise.resolve({ workspaceId, ownerId, inboxProjectId: randomUUID() });
  }

  createSession(input: CreateSessionRecord): Promise<SessionRecord> {
    const id = randomUUID();
    const now = new Date();
    const record: StoredSession = {
      id,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      csrfHash: input.csrfHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
      tokenHashHex: input.tokenHash.toString('hex'),
    };
    this.sessions.set(id, record);
    return Promise.resolve(this.publicRecord(record));
  }

  findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null> {
    const hex = tokenHash.toString('hex');
    for (const s of this.sessions.values()) {
      if (s.tokenHashHex === hex) return Promise.resolve(this.publicRecord(s));
    }
    return Promise.resolve(null);
  }

  touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      s.lastSeenAt = lastSeenAt;
      s.expiresAt = expiresAt;
    }
    return Promise.resolve();
  }

  updateSessionCsrf(id: string, csrfHash: Buffer): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.csrfHash = csrfHash;
    return Promise.resolve();
  }

  revokeSession(id: string, revokedAt: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.revokedAt === null) s.revokedAt = revokedAt;
    return Promise.resolve();
  }

  revokeAllOwnerSessions(ownerId: string, workspaceId: string, revokedAt: Date): Promise<number> {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.ownerId === ownerId && s.workspaceId === workspaceId && s.revokedAt === null) {
        s.revokedAt = revokedAt;
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  listOwnerSessions(ownerId: string, workspaceId: string): Promise<SessionRecord[]> {
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((s) => s.ownerId === ownerId && s.workspaceId === workspaceId)
        .map((s) => this.publicRecord(s)),
    );
  }

  changePassword(
    ownerId: string,
    workspaceId: string,
    passwordHash: string,
    changedAt: Date,
    expectedPasswordHash: string,
  ): Promise<number> {
    if (!this.owner || this.owner.passwordHash !== expectedPasswordHash)
      return Promise.reject(new InvalidCredentialsError());
    if (this.owner.id === ownerId) {
      this.owner = { ...this.owner, passwordHash, passwordChangedAt: changedAt };
    }
    return this.revokeAllOwnerSessions(ownerId, workspaceId, changedAt);
  }

  resetPasswordWithRecovery(
    ownerId: string,
    workspaceId: string,
    passwordHash: string,
    recoveryCodeHash: Buffer,
    changedAt: Date,
  ): Promise<number> {
    if (this.owner && this.owner.id === ownerId) {
      this.owner = { ...this.owner, passwordHash, recoveryCodeHash, passwordChangedAt: changedAt };
    }
    return this.revokeAllOwnerSessions(ownerId, workspaceId, changedAt);
  }

  private publicRecord(s: StoredSession): SessionRecord {
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      ownerId: s.ownerId,
      csrfHash: s.csrfHash,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      absoluteExpiresAt: s.absoluteExpiresAt,
      revokedAt: s.revokedAt,
    };
  }
}

/**
 * DB-backed {@link AuthRepository} bridging the auth use cases to `@redai/db`.
 * This is the production adapter (the unit tests use an in-memory fake instead).
 * Transaction boundaries live here: bootstrap, password change and recovery reset
 * each run inside a single `withTransaction`, so a partial write never lands.
 */
import {
  OwnerRepository,
  ProjectRepository,
  SessionRepository,
  WorkspaceRepository,
  withTransaction,
} from '@redai/db';
import type { Pool } from '@redai/db';
import type { OwnerRow, SessionRow } from '@redai/db';
import { OwnerExistsError } from './errors.js';
import type {
  AuthRepository,
  BootstrapInput,
  BootstrapResult,
  CreateSessionRecord,
  OwnerRecord,
  SessionRecord,
} from './ports.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function toOwnerRecord(row: OwnerRow): OwnerRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    username: row.username,
    passwordHash: row.password_hash,
    recoveryCodeHash: row.recovery_code_hash,
    passwordChangedAt: row.password_changed_at,
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    csrfHash: row.csrf_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createDbAuthRepository(pool: Pool): AuthRepository {
  const owners = new OwnerRepository(pool);
  const sessions = new SessionRepository(pool);

  return {
    async countOwners(): Promise<number> {
      return owners.count();
    },

    async getOwnerByUsername(username: string): Promise<OwnerRecord | null> {
      const row = await owners.getByUsername(username);
      return row ? toOwnerRecord(row) : null;
    },

    async getOwnerById(id: string): Promise<OwnerRecord | null> {
      const row = await owners.getById(id);
      return row ? toOwnerRecord(row) : null;
    },

    async getSingletonOwner(): Promise<OwnerRecord | null> {
      const row = await owners.getSingleton();
      return row ? toOwnerRecord(row) : null;
    },

    async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
      try {
        return await withTransaction(pool, async (tx) => {
          const workspace = await new WorkspaceRepository(tx).create({
            name: input.workspaceName,
            installationId: input.installationId,
          });
          const owner = await new OwnerRepository(tx).create({
            workspaceId: workspace.id,
            username: input.username,
            passwordHash: input.passwordHash,
            recoveryCodeHash: input.recoveryCodeHash,
          });
          const inbox = await new ProjectRepository(tx).create({
            workspaceId: workspace.id,
            name: input.inboxName,
            description: 'System inbox project',
            isInbox: true,
          });
          return {
            workspaceId: workspace.id,
            ownerId: owner.id,
            inboxProjectId: inbox.id,
          };
        });
      } catch (err) {
        // Singleton workspace / unique owner (or username) → exactly one bootstrap wins.
        if (isUniqueViolation(err)) throw new OwnerExistsError();
        throw err;
      }
    },

    async createSession(input: CreateSessionRecord): Promise<SessionRecord> {
      const row = await sessions.create({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        tokenHash: input.tokenHash,
        csrfHash: input.csrfHash,
        expiresAt: input.expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
      });
      return toSessionRecord(row);
    },

    async findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null> {
      const row = await sessions.findByTokenHash(tokenHash);
      return row ? toSessionRecord(row) : null;
    },

    async touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
      await sessions.touch(id, lastSeenAt, expiresAt);
    },

    async updateSessionCsrf(id: string, csrfHash: Buffer): Promise<void> {
      await sessions.updateCsrf(id, csrfHash);
    },

    async revokeSession(id: string, revokedAt: Date): Promise<void> {
      await sessions.revoke(id, revokedAt);
    },

    async revokeAllOwnerSessions(
      ownerId: string,
      workspaceId: string,
      revokedAt: Date,
    ): Promise<number> {
      return sessions.revokeAllForOwner(ownerId, workspaceId, revokedAt);
    },

    async changePassword(
      ownerId: string,
      workspaceId: string,
      passwordHash: string,
      changedAt: Date,
    ): Promise<number> {
      return withTransaction(pool, async (tx) => {
        await new OwnerRepository(tx).updatePassword(ownerId, passwordHash, changedAt);
        return new SessionRepository(tx).revokeAllForOwner(ownerId, workspaceId, changedAt);
      });
    },

    async resetPasswordWithRecovery(
      ownerId: string,
      workspaceId: string,
      passwordHash: string,
      recoveryCodeHash: Buffer,
      changedAt: Date,
    ): Promise<number> {
      return withTransaction(pool, async (tx) => {
        const ownerRepo = new OwnerRepository(tx);
        await ownerRepo.updatePassword(ownerId, passwordHash, changedAt);
        await ownerRepo.updateRecoveryCode(ownerId, recoveryCodeHash);
        return new SessionRepository(tx).revokeAllForOwner(ownerId, workspaceId, changedAt);
      });
    },
  };
}

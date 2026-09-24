/**
 * DB-backed {@link WorkerIdentityRepository} bridging the worker-identity use cases
 * to `@redai/db`. This is the production adapter (unit tests use the in-memory fake).
 *
 * Transaction boundaries live here. `redeemEnrollment` runs inside one
 * `withTransaction`: it locks the enrollment token `FOR UPDATE`, rejects a consumed
 * or expired token, creates the worker + first credential, and flips the token to
 * consumed under a `WHERE consumed_at IS NULL` guard — so a partial write never
 * lands and two racers can never both mint a worker. `rotateCredential` and
 * `revokeWorker` are likewise atomic.
 *
 * The DB only ever stores hashes (`token_hash bytea`); a leaked row can neither be
 * replayed as a bearer token nor reveal the credential.
 */
import { withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
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
  WorkerDefaults,
  WorkerIdentityRepository,
  WorkerRecord,
  WorkerState,
} from './ports.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

interface EnrollmentTokenRow {
  id: string;
  workspace_id: string;
  token_hash: Buffer;
  worker_defaults: WorkerDefaults;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_worker_id: string | null;
  created_at: Date;
}

interface WorkerRow {
  id: string;
  workspace_id: string;
  display_name: string;
  zone: string;
  capacity: number;
  state: WorkerState;
  agent_version: string;
  manifest_sha256: string;
  session_id: string | null;
  session_generation: string;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkerCredentialRow {
  id: string;
  workspace_id: string;
  worker_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function toTokenRecord(row: EnrollmentTokenRow): EnrollmentTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tokenHash: row.token_hash,
    workerDefaults: row.worker_defaults,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedWorkerId: row.consumed_worker_id,
    createdAt: row.created_at,
  };
}

function toWorkerRecord(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    zone: row.zone,
    capacity: row.capacity,
    state: row.state,
    agentVersion: row.agent_version,
    manifestSha256: row.manifest_sha256,
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCredentialRecord(row: WorkerCredentialRow): WorkerCredentialRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workerId: row.worker_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function createDbWorkerIdentityRepository(pool: Pool): WorkerIdentityRepository {
  return {
    async createEnrollmentToken(input: CreateEnrollmentTokenInput): Promise<EnrollmentTokenRecord> {
      const result = await pool.query<EnrollmentTokenRow>(
        `INSERT INTO enrollment_tokens (workspace_id, token_hash, worker_defaults, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING *`,
        [input.workspaceId, input.tokenHash, JSON.stringify(input.workerDefaults), input.expiresAt],
      );
      return toTokenRecord(required(result.rows[0], 'enrollment token insert returned no row'));
    },

    async redeemEnrollment(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentOutcome> {
      return withTransaction(pool, async (tx: Executor) => {
        const tokenResult = await tx.query<EnrollmentTokenRow>(
          `SELECT * FROM enrollment_tokens WHERE token_hash = $1 FOR UPDATE`,
          [input.enrollmentTokenHash],
        );
        const token = tokenResult.rows[0];
        if (!token) throw new EnrollmentInvalidError();
        if (token.consumed_at !== null) throw new EnrollmentAlreadyConsumedError();
        if (input.now.getTime() >= token.expires_at.getTime()) {
          throw new EnrollmentExpiredError();
        }

        const defaults = token.worker_defaults;
        const displayName = input.worker.displayName || defaults.displayName || 'worker';
        const zone = defaults.zone;

        let workerId: string;
        try {
          const workerResult = await tx.query<{ id: string }>(
            `INSERT INTO workers
               (id, workspace_id, display_name, zone, capacity, state, agent_version, manifest_sha256)
             VALUES ($1, $2, $3, $4, $5, 'offline', $6, $7)
             RETURNING id`,
            [
              input.worker.id,
              token.workspace_id,
              displayName,
              zone,
              input.worker.capacity,
              input.worker.agentVersion,
              input.worker.manifestSha256,
            ],
          );
          workerId = required(workerResult.rows[0], 'worker insert returned no row').id;
        } catch (err) {
          // Duplicate worker id (client reused a UUID) is a hard conflict, not a retry.
          if (isUniqueViolation(err)) throw new EnrollmentInvalidError();
          throw err;
        }

        const credentialResult = await tx.query<{ id: string }>(
          `INSERT INTO worker_credentials (workspace_id, worker_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [token.workspace_id, workerId, input.credential.tokenHash, input.credential.expiresAt],
        );
        const credentialId = required(
          credentialResult.rows[0],
          'credential insert returned no row',
        ).id;

        const consume = await tx.query(
          `UPDATE enrollment_tokens
             SET consumed_at = $2, consumed_worker_id = $3
           WHERE id = $1 AND consumed_at IS NULL`,
          [token.id, input.now, workerId],
        );
        // The FOR UPDATE lock makes this deterministic, but guard anyway.
        if ((consume.rowCount ?? 0) !== 1) throw new EnrollmentAlreadyConsumedError();

        const wsResult = await tx.query<{ installation_id: string }>(
          `SELECT installation_id FROM workspaces WHERE id = $1`,
          [token.workspace_id],
        );
        const installationId = required(
          wsResult.rows[0],
          'workspace lookup returned no row',
        ).installation_id;

        return { workerId, workspaceId: token.workspace_id, installationId, credentialId };
      });
    },

    async findCredentialByHash(tokenHash: Buffer): Promise<CredentialWithWorker | null> {
      const result = await pool.query<WorkerCredentialRow & { w_row: WorkerRow }>(
        `SELECT c.*, to_jsonb(w.*) AS w_row
           FROM worker_credentials c
           JOIN workers w ON w.id = c.worker_id AND w.workspace_id = c.workspace_id
          WHERE c.token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { w_row, ...credentialRow } = row;
      return {
        credential: toCredentialRecord(credentialRow as WorkerCredentialRow),
        worker: toWorkerRecord(w_row),
      };
    },

    async getWorkerById(workerId: string): Promise<WorkerRecord | null> {
      const result = await pool.query<WorkerRow>(`SELECT * FROM workers WHERE id = $1`, [workerId]);
      const row = result.rows[0];
      return row ? toWorkerRecord(row) : null;
    },

    async createCredential(input: NewCredentialInput): Promise<WorkerCredentialRecord> {
      const result = await pool.query<WorkerCredentialRow>(
        `INSERT INTO worker_credentials (workspace_id, worker_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.workspaceId, input.workerId, input.tokenHash, input.expiresAt],
      );
      return toCredentialRecord(required(result.rows[0], 'credential insert returned no row'));
    },

    async setCredentialRevokedAt(credentialId: string, revokedAt: Date): Promise<void> {
      await pool.query(
        `UPDATE worker_credentials SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [credentialId, revokedAt],
      );
    },

    async rotateCredential(input: {
      workerId: string;
      workspaceId: string;
      newCredential: { tokenHash: Buffer; expiresAt: Date };
      retiringOverlapUntil: Date;
    }): Promise<{ credentialId: string }> {
      return withTransaction(pool, async (tx: Executor) => {
        const result = await tx.query<{ id: string }>(
          `INSERT INTO worker_credentials (workspace_id, worker_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [
            input.workspaceId,
            input.workerId,
            input.newCredential.tokenHash,
            input.newCredential.expiresAt,
          ],
        );
        const credentialId = required(result.rows[0], 'credential insert returned no row').id;
        return { credentialId };
      });
    },

    async revokeWorker(workerId: string, revokedAt: Date): Promise<void> {
      await withTransaction(pool, async (tx: Executor) => {
        await tx.query(
          `UPDATE workers SET state = 'revoked', revoked_at = $2, updated_at = $2
             WHERE id = $1 AND revoked_at IS NULL`,
          [workerId, revokedAt],
        );
        await tx.query(
          `UPDATE worker_credentials SET revoked_at = $2
             WHERE worker_id = $1 AND revoked_at IS NULL`,
          [workerId, revokedAt],
        );
      });
    },
  };
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

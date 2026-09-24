import type { Executor } from '../pool.js';
import type { SessionRow } from '../types.js';

export interface CreateSessionInput {
  workspaceId: string;
  ownerId: string;
  /** SHA-256 of the opaque session token. The raw token never reaches the DB. */
  tokenHash: Buffer;
  /** SHA-256 of the CSRF token bound to this session. */
  csrfHash: Buffer;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Server-side owner sessions. The DB only ever stores hashes of the opaque token
 * and CSRF token (`token_hash`/`csrf_hash` are `bytea UNIQUE`/`bytea`); lookups are
 * by `token_hash`, so a leaked row can neither be replayed as a cookie nor reveal
 * the CSRF value. Expiry is enforced by the application (idle `expires_at` slides on
 * use up to the absolute cap); `revoked_at` is set on logout / password change.
 */
export class SessionRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const result = await this.exec.query<SessionRow>(
      `INSERT INTO sessions
         (workspace_id, owner_id, token_hash, csrf_hash, expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.workspaceId,
        input.ownerId,
        input.tokenHash,
        input.csrfHash,
        input.expiresAt,
        input.absoluteExpiresAt,
      ],
    );
    return required(result.rows[0], 'session insert returned no row');
  }

  async findByTokenHash(tokenHash: Buffer): Promise<SessionRow | null> {
    const result = await this.exec.query<SessionRow>(
      'SELECT * FROM sessions WHERE token_hash = $1',
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<SessionRow | null> {
    const result = await this.exec.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  /** Slide idle expiry forward (never past the absolute cap; the CHECK enforces that too). */
  async touch(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    await this.exec.query(
      'UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1',
      [id, lastSeenAt, expiresAt],
    );
  }

  /** Rotate the CSRF hash bound to a session. */
  async updateCsrf(id: string, csrfHash: Buffer): Promise<void> {
    await this.exec.query('UPDATE sessions SET csrf_hash = $2 WHERE id = $1', [id, csrfHash]);
  }

  /** Revoke one session (idempotent: only sets `revoked_at` while it is still NULL). */
  async revoke(id: string, revokedAt: Date): Promise<void> {
    await this.exec.query(
      'UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, revokedAt],
    );
  }

  /** Revoke every live session for the owner (password change / reset). Returns the count revoked. */
  async revokeAllForOwner(ownerId: string, workspaceId: string, revokedAt: Date): Promise<number> {
    const result = await this.exec.query(
      `UPDATE sessions SET revoked_at = $3
       WHERE owner_id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
      [ownerId, workspaceId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  /** Sessions for the owner ordered newest-first (Security settings list; safe metadata only upstream). */
  async listByOwner(ownerId: string, workspaceId: string): Promise<SessionRow[]> {
    const result = await this.exec.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE owner_id = $1 AND workspace_id = $2
       ORDER BY created_at DESC`,
      [ownerId, workspaceId],
    );
    return result.rows;
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

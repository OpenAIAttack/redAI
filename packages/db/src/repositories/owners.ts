import type { Executor } from '../pool.js';
import type { OwnerRow } from '../types.js';

export interface CreateOwnerInput {
  workspaceId: string;
  username: string;
  passwordHash: string;
  recoveryCodeHash: Buffer;
}

/** The single owner of a workspace (one owner per workspace: `workspace_id` is UNIQUE). */
export class OwnerRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateOwnerInput): Promise<OwnerRow> {
    const result = await this.exec.query<OwnerRow>(
      `INSERT INTO owners (workspace_id, username, password_hash, recovery_code_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.workspaceId, input.username, input.passwordHash, input.recoveryCodeHash],
    );
    return required(result.rows[0], 'owner insert returned no row');
  }

  async getByWorkspace(workspaceId: string): Promise<OwnerRow | null> {
    const result = await this.exec.query<OwnerRow>(
      'SELECT * FROM owners WHERE workspace_id = $1',
      [workspaceId],
    );
    return result.rows[0] ?? null;
  }

  async getByUsername(username: string): Promise<OwnerRow | null> {
    const result = await this.exec.query<OwnerRow>('SELECT * FROM owners WHERE username = $1', [
      username,
    ]);
    return result.rows[0] ?? null;
  }

  async getById(id: string): Promise<OwnerRow | null> {
    const result = await this.exec.query<OwnerRow>('SELECT * FROM owners WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  /** The single owner if the install is bootstrapped (there is at most one row). */
  async getSingleton(): Promise<OwnerRow | null> {
    const result = await this.exec.query<OwnerRow>('SELECT * FROM owners LIMIT 1');
    return result.rows[0] ?? null;
  }

  async count(): Promise<number> {
    const result = await this.exec.query<{ n: string }>('SELECT count(*)::text AS n FROM owners');
    return Number(result.rows[0]?.n ?? '0');
  }

  /** Set a new password hash and stamp `password_changed_at`. Caller revokes sessions. */
  async updatePassword(id: string, passwordHash: string, passwordChangedAt: Date): Promise<void> {
    await this.exec.query(
      `UPDATE owners
       SET password_hash = $2, password_changed_at = $3, updated_at = now()
       WHERE id = $1`,
      [id, passwordHash, passwordChangedAt],
    );
  }

  /** Rotate the recovery code hash (recovery codes are single-use: a use replaces the hash). */
  async updateRecoveryCode(id: string, recoveryCodeHash: Buffer): Promise<void> {
    await this.exec.query(
      'UPDATE owners SET recovery_code_hash = $2, updated_at = now() WHERE id = $1',
      [id, recoveryCodeHash],
    );
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

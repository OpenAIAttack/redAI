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
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

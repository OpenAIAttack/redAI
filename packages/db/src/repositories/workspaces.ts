import type { Executor } from '../pool.js';
import type { WorkspaceRow } from '../types.js';

export interface CreateWorkspaceInput {
  name: string;
  installationId: string;
  settings?: Record<string, unknown>;
}

/** Workspace is a singleton per install (partial unique `singleton`); create fails on a second row. */
export class WorkspaceRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    const result = await this.exec.query<WorkspaceRow>(
      `INSERT INTO workspaces (name, installation_id, settings)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [input.name, input.installationId, JSON.stringify(input.settings ?? {})],
    );
    return required(result.rows[0], 'workspace insert returned no row');
  }

  async getById(id: string): Promise<WorkspaceRow | null> {
    const result = await this.exec.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  /** The single workspace, if one exists. */
  async getSingleton(): Promise<WorkspaceRow | null> {
    const result = await this.exec.query<WorkspaceRow>('SELECT * FROM workspaces LIMIT 1');
    return result.rows[0] ?? null;
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

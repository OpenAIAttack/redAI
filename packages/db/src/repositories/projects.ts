import type { Executor } from '../pool.js';
import type { ApprovalMode, DataMode, ProjectRow } from '../types.js';

export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  description?: string;
  isInbox?: boolean;
  approvalMode?: ApprovalMode;
  dataMode?: DataMode;
}

/** Projects scope owner work. Exactly one Inbox project per workspace (partial unique `one_inbox`). */
export class ProjectRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateProjectInput): Promise<ProjectRow> {
    const result = await this.exec.query<ProjectRow>(
      `INSERT INTO projects (workspace_id, name, description, is_inbox, approval_mode, data_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.workspaceId,
        input.name,
        input.description ?? '',
        input.isInbox ?? false,
        input.approvalMode ?? 'automatic',
        input.dataMode ?? 'redacted_cloud',
      ],
    );
    return required(result.rows[0], 'project insert returned no row');
  }

  async getById(id: string, workspaceId: string): Promise<ProjectRow | null> {
    const result = await this.exec.query<ProjectRow>(
      'SELECT * FROM projects WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId],
    );
    return result.rows[0] ?? null;
  }

  async listByWorkspace(workspaceId: string): Promise<ProjectRow[]> {
    const result = await this.exec.query<ProjectRow>(
      'SELECT * FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC',
      [workspaceId],
    );
    return result.rows;
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

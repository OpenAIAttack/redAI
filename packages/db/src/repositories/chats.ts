import type { Executor } from '../pool.js';
import type { ChatRow } from '../types.js';

export interface CreateChatInput {
  workspaceId: string;
  projectId: string;
  title?: string;
  pinned?: boolean;
}

/** Chats belong to a project and carry their own message sequence counter. */
export class ChatRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateChatInput): Promise<ChatRow> {
    const result = await this.exec.query<ChatRow>(
      `INSERT INTO chats (workspace_id, project_id, title, pinned)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.workspaceId, input.projectId, input.title ?? '', input.pinned ?? false],
    );
    return required(result.rows[0], 'chat insert returned no row');
  }

  async getById(id: string, workspaceId: string): Promise<ChatRow | null> {
    const result = await this.exec.query<ChatRow>(
      'SELECT * FROM chats WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lock the chat row FOR UPDATE. The create-run transaction locks the chat before
   * checking the one-active-run invariant so two tabs serialize (docs/05 §5).
   */
  async lockForUpdate(tx: Executor, id: string, workspaceId: string): Promise<ChatRow | null> {
    const result = await tx.query<ChatRow>(
      'SELECT * FROM chats WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [id, workspaceId],
    );
    return result.rows[0] ?? null;
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

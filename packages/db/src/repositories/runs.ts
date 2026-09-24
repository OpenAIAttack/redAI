import type { Executor } from '../pool.js';
import { ACTIVE_RUN_STATES } from '../types.js';
import type { RunKind, RunMode, RunRow, RunState } from '../types.js';

export interface CreateRunInput {
  workspaceId: string;
  projectId: string;
  chatId: string;
  mode: RunMode;
  providerConfigId: string;
  budgetLimitMicroUsd: bigint | string;
  /** Absolute expiry (docs/05 §4). */
  expiresAt: Date;
  kind?: RunKind;
  state?: RunState;
  configSnapshot?: Record<string, unknown>;
  resumesRunId?: string | null;
}

/**
 * Runs are the durable unit of work. `one_active_run_per_chat` (a partial unique
 * index over the active states) enforces INV-002 at the DB level, so a second
 * concurrent active run on the same chat is rejected with a unique violation.
 */
export class RunRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateRunInput): Promise<RunRow> {
    const result = await this.exec.query<RunRow>(
      `INSERT INTO runs (
         workspace_id, project_id, chat_id, mode, kind, state,
         provider_config_id, config_snapshot, budget_limit_micro_usd, expires_at, resumes_run_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       RETURNING *`,
      [
        input.workspaceId,
        input.projectId,
        input.chatId,
        input.mode,
        input.kind ?? 'normal',
        input.state ?? 'queued',
        input.providerConfigId,
        JSON.stringify(input.configSnapshot ?? {}),
        input.budgetLimitMicroUsd.toString(),
        input.expiresAt,
        input.resumesRunId ?? null,
      ],
    );
    return required(result.rows[0], 'run insert returned no row');
  }

  async getById(id: string, workspaceId: string): Promise<RunRow | null> {
    const result = await this.exec.query<RunRow>(
      'SELECT * FROM runs WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId],
    );
    return result.rows[0] ?? null;
  }

  /** The active run on a chat, if any (there can be at most one). */
  async findActiveByChat(chatId: string, workspaceId: string): Promise<RunRow | null> {
    const result = await this.exec.query<RunRow>(
      `SELECT * FROM runs
       WHERE chat_id = $1 AND workspace_id = $2 AND state = ANY($3::text[])
       LIMIT 1`,
      [chatId, workspaceId, [...ACTIVE_RUN_STATES]],
    );
    return result.rows[0] ?? null;
  }

  async updateState(id: string, workspaceId: string, state: RunState): Promise<RunRow | null> {
    const result = await this.exec.query<RunRow>(
      `UPDATE runs SET state = $3, updated_at = now(), revision = revision + 1
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [id, workspaceId, state],
    );
    return result.rows[0] ?? null;
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

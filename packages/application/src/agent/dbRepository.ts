/**
 * DB-backed {@link AgentRunRepository} over `@redai/db` (T13). Production adapter; the
 * service/runtime unit tests use the in-memory fake. Every statement carries an explicit
 * `workspace_id` (and, for chat rows, `project_id`/`chat_id`) predicate so a request
 * scoped to project A can never read/write project B (INV-001).
 *
 * Durability (docs/07):
 *   - `createAgentRun` reserves the idempotency key, inserts the run (mode='agent') +
 *     user message + `run.created` event, and completes the reservation in ONE
 *     transaction, so a repeated key / double-submit converges on exactly one run.
 *   - The lease is compare-and-set: `claimQueuedAgentRun` bumps `runtime_fence` under a
 *     `FOR UPDATE SKIP LOCKED` row lock; `commitCheckpoint` / `finalizeAgentRun` /
 *     `terminateAgentRun` are fence-guarded UPDATEs, so a runtime whose lease expired
 *     writes zero rows — no duplicate logical dispatch, no duplicate final message.
 *   - The final assistant message is inserted with `ON CONFLICT (id) DO NOTHING` under a
 *     STABLE derived id, so a resumed finalize never duplicates it.
 *
 * No DB transaction is held across a model call — the provider round-trip happens in the
 * service between `commitCheckpoint`s (architecture §6).
 */
import { appendEvent, withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
import { toCheckpointJson } from './checkpoint.js';
import type {
  AgentClaimedRun,
  AgentRunRepository,
  CommitCheckpointInput,
  CreateAgentRunInput,
  CreateAgentRunOutcome,
  FenceResult,
  FinalizeAgentRunInput,
  MessageRecord,
  Page,
  PageQuery,
  RunRecord,
  TerminateAgentRunInput,
} from './ports.js';

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

interface RunDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  chat_id: string;
  mode: RunRecord['mode'];
  kind: RunRecord['kind'];
  state: RunRecord['state'];
  outcome: RunRecord['outcome'];
  provider_config_id: string;
  config_snapshot: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  runtime_owner: string | null;
  runtime_fence: string;
  runtime_lease_until: Date | null;
  step_count: number;
  budget_limit_micro_usd: string;
  stop_reason: string | null;
  expires_at: Date;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  chat_id: string;
  run_id: string | null;
  client_message_id: string | null;
  seq: string;
  role: MessageRecord['role'];
  text_content: string;
  content_json: Record<string, unknown>;
  status: MessageRecord['status'];
  created_at: Date;
}

const RUN_COLS =
  'id, workspace_id, project_id, chat_id, mode, kind, state, outcome, provider_config_id, ' +
  'config_snapshot, checkpoint, runtime_owner, runtime_fence, runtime_lease_until, step_count, ' +
  'budget_limit_micro_usd, stop_reason, expires_at, revision, created_at, updated_at';

const MSG_COLS =
  'id, workspace_id, project_id, chat_id, run_id, client_message_id, seq, role, text_content, ' +
  'content_json, status, created_at';

function toRun(r: RunDbRow): RunRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    chatId: r.chat_id,
    mode: r.mode,
    kind: r.kind,
    state: r.state,
    outcome: r.outcome,
    providerConfigId: r.provider_config_id,
    configSnapshot: r.config_snapshot,
    checkpoint: r.checkpoint,
    runtimeOwner: r.runtime_owner,
    runtimeFence: r.runtime_fence,
    runtimeLeaseUntil: r.runtime_lease_until,
    stepCount: r.step_count,
    budgetLimitMicroUsd: r.budget_limit_micro_usd,
    stopReason: r.stop_reason,
    expiresAt: r.expires_at,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: MessageDbRow): MessageRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    chatId: r.chat_id,
    runId: r.run_id,
    clientMessageId: r.client_message_id,
    seq: r.seq,
    role: r.role,
    textContent: r.text_content,
    contentJson: r.content_json,
    status: r.status,
    createdAt: r.created_at,
  };
}

async function nextSeq(
  tx: Executor,
  workspaceId: string,
  projectId: string,
  chatId: string,
): Promise<string> {
  const res = await tx.query<{ message_seq: string }>(
    `UPDATE chats SET message_seq = message_seq + 1, updated_at = now()
     WHERE id = $1 AND project_id = $2 AND workspace_id = $3
     RETURNING message_seq`,
    [chatId, projectId, workspaceId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('chat not found for seq allocation');
  return row.message_seq;
}

export function createDbAgentRunRepository(pool: Pool): AgentRunRepository {
  return new DbAgentRunRepository(pool);
}

class DbAgentRunRepository implements AgentRunRepository {
  public constructor(private readonly pool: Pool) {}

  async createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunOutcome> {
    return withTransaction(this.pool, async (tx) => {
      const k = input.idempotency;
      const reserved = await tx.query<{ idempotency_key: string }>(
        `INSERT INTO idempotency_keys
           (workspace_id, actor_key, method, route, idempotency_key, body_sha256, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7)
         ON CONFLICT (workspace_id, actor_key, method, route, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [k.workspaceId, k.actorKey, k.method, k.route, k.key, k.bodySha256, k.expiresAt],
      );
      if (reserved.rowCount === 0) return this.replayIdempotent(tx, input);

      await tx.query('SAVEPOINT biz');
      let run: RunRecord | null = null;
      let userMessage: MessageRecord | null = null;
      let created = true;
      try {
        run = await this.insertRun(tx, input);
        userMessage = await this.insertUserMessage(tx, input, run.id);
      } catch (err) {
        if (pgCode(err) === UNIQUE_VIOLATION) {
          await tx.query('ROLLBACK TO SAVEPOINT biz');
          const existing = await this.findUserMessageByClientId(
            tx,
            input.workspaceId,
            input.projectId,
            input.chatId,
            input.clientMessageId,
          );
          if (existing && existing.runId) {
            const existingRun = await this.getRun(
              input.workspaceId,
              input.projectId,
              existing.runId,
            );
            if (existingRun) {
              run = existingRun;
              userMessage = existing;
              created = false;
            }
          }
          if (!run) throw activeRunError();
        } else if (pgCode(err) === FK_VIOLATION) {
          throw new Error('chat or provider config not found for agent run');
        } else {
          throw err;
        }
      }

      if (created && run) {
        await appendEvent(tx, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: run.id,
          eventType: 'run.created',
          payload: { run_id: run.id, chat_id: input.chatId, mode: 'agent' },
        });
      }

      await tx.query(
        `UPDATE idempotency_keys
         SET state = 'completed', response_status = 201, response_json = $6::jsonb
         WHERE workspace_id = $1 AND actor_key = $2 AND method = $3 AND route = $4
           AND idempotency_key = $5`,
        [
          k.workspaceId,
          k.actorKey,
          k.method,
          k.route,
          k.key,
          JSON.stringify({ run_id: run!.id, user_message_id: userMessage!.id }),
        ],
      );

      return created
        ? { kind: 'created', run: run!, userMessage: userMessage! }
        : { kind: 'replayed', run: run!, userMessage: userMessage! };
    });
  }

  private async replayIdempotent(
    tx: Executor,
    input: CreateAgentRunInput,
  ): Promise<CreateAgentRunOutcome> {
    const k = input.idempotency;
    const row = await tx.query<{
      body_sha256: string;
      state: string;
      response_json: { run_id?: string; user_message_id?: string } | null;
    }>(
      `SELECT body_sha256, state, response_json FROM idempotency_keys
       WHERE workspace_id = $1 AND actor_key = $2 AND method = $3 AND route = $4
         AND idempotency_key = $5`,
      [k.workspaceId, k.actorKey, k.method, k.route, k.key],
    );
    const r = row.rows[0];
    if (!r) return { kind: 'in_progress' };
    if (r.body_sha256 !== k.bodySha256) return { kind: 'conflict' };
    if (r.state !== 'completed' || !r.response_json) return { kind: 'in_progress' };
    const runId = r.response_json.run_id;
    const userMessageId = r.response_json.user_message_id;
    if (!runId || !userMessageId) return { kind: 'in_progress' };
    const run = await this.getRun(input.workspaceId, input.projectId, runId);
    const msg = await this.getMessage(tx, input.workspaceId, input.projectId, userMessageId);
    if (!run || !msg) return { kind: 'in_progress' };
    return { kind: 'replayed', run, userMessage: msg };
  }

  private async insertRun(tx: Executor, input: CreateAgentRunInput): Promise<RunRecord> {
    const snapshot = {
      mode: 'agent',
      objective: input.text,
      data_mode: input.dataMode,
      provider_config_id: input.providerConfigId,
      attached_artifact_ids: input.attachedArtifactIds,
      agent_session_id: input.agentSessionId,
      max_steps: input.maxSteps,
    };
    const checkpoint = {
      phase: 'planning',
      step_no: 0,
      agent_session_id: input.agentSessionId,
      objective: input.text,
      active_elapsed_ms: 0,
    };
    const res = await tx.query<RunDbRow>(
      `INSERT INTO runs
         (id, workspace_id, project_id, chat_id, mode, kind, state, provider_config_id,
          config_snapshot, checkpoint, budget_limit_micro_usd, expires_at)
       VALUES ($1, $2, $3, $4, 'agent', 'normal', 'queued', $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING ${RUN_COLS}`,
      [
        input.runId,
        input.workspaceId,
        input.projectId,
        input.chatId,
        input.providerConfigId,
        JSON.stringify(snapshot),
        JSON.stringify(checkpoint),
        input.budgetLimitMicroUsd,
        input.expiresAt,
      ],
    );
    return toRun(res.rows[0]!);
  }

  private async insertUserMessage(
    tx: Executor,
    input: CreateAgentRunInput,
    runId: string,
  ): Promise<MessageRecord> {
    const seq = await nextSeq(tx, input.workspaceId, input.projectId, input.chatId);
    const res = await tx.query<MessageDbRow>(
      `INSERT INTO messages
         (id, workspace_id, project_id, chat_id, run_id, client_message_id, seq, role,
          text_content, content_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8, $9::jsonb, 'completed')
       RETURNING ${MSG_COLS}`,
      [
        input.userMessageId,
        input.workspaceId,
        input.projectId,
        input.chatId,
        runId,
        input.clientMessageId,
        seq,
        input.text,
        JSON.stringify({ attached_artifact_ids: input.attachedArtifactIds }),
      ],
    );
    return toMessage(res.rows[0]!);
  }

  private async findUserMessageByClientId(
    tx: Executor,
    workspaceId: string,
    projectId: string,
    chatId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    const res = await tx.query<MessageDbRow>(
      `SELECT ${MSG_COLS} FROM messages
       WHERE workspace_id = $1 AND project_id = $2 AND chat_id = $3
         AND client_message_id = $4 AND role = 'user'`,
      [workspaceId, projectId, chatId, clientMessageId],
    );
    return res.rows[0] ? toMessage(res.rows[0]) : null;
  }

  private async getMessage(
    tx: Executor,
    workspaceId: string,
    projectId: string,
    messageId: string,
  ): Promise<MessageRecord | null> {
    const res = await tx.query<MessageDbRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [messageId, workspaceId, projectId],
    );
    return res.rows[0] ? toMessage(res.rows[0]) : null;
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord | null> {
    const res = await this.pool.query<RunDbRow>(
      `SELECT ${RUN_COLS} FROM runs WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [runId, workspaceId, projectId],
    );
    return res.rows[0] ? toRun(res.rows[0]) : null;
  }

  async listMessages(
    workspaceId: string,
    projectId: string,
    chatId: string,
    page: PageQuery,
  ): Promise<Page<MessageRecord>> {
    const res = await this.pool.query<MessageDbRow>(
      `SELECT ${MSG_COLS} FROM messages
       WHERE workspace_id = $1 AND project_id = $2 AND chat_id = $3
       ORDER BY seq ASC LIMIT $4`,
      [workspaceId, projectId, chatId, page.limit],
    );
    return { items: res.rows.map(toMessage), nextCursor: null };
  }

  async claimQueuedAgentRun(
    owner: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<AgentClaimedRun | null> {
    return withTransaction(this.pool, async (tx) => {
      const res = await tx.query<RunDbRow>(
        `UPDATE runs SET
           runtime_owner = $1,
           runtime_fence = runtime_fence + 1,
           runtime_lease_until = $2,
           state = 'running',
           updated_at = now(),
           revision = revision + 1
         WHERE id = (
           SELECT id FROM runs
           WHERE mode = 'agent'
             AND (
               state = 'queued'
               OR (state = 'running'
                   AND (runtime_lease_until IS NULL OR runtime_lease_until < $3))
             )
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${RUN_COLS}`,
        [owner, leaseUntil, now],
      );
      const row = res.rows[0];
      if (!row) return null;
      const run = toRun(row);
      return { run, fence: run.runtimeFence };
    });
  }

  async commitCheckpoint(input: CommitCheckpointInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';

      const checkpoint = toCheckpointJson(input.checkpoint, 0);
      await tx.query(
        `UPDATE runs SET
           checkpoint = ($4::jsonb
             || jsonb_build_object('active_elapsed_ms', active_elapsed_ms + $5::bigint)),
           active_elapsed_ms = active_elapsed_ms + $5::bigint,
           plan = CASE WHEN $6 THEN $7::jsonb ELSE plan END,
           plan_revision = plan_revision + (CASE WHEN $6 THEN 1 ELSE 0 END),
           step_count = $8,
           updated_at = now(),
           revision = revision + 1
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [
          input.runId,
          input.workspaceId,
          input.expectedFence,
          JSON.stringify(checkpoint),
          String(input.activeElapsedDeltaMs),
          input.bumpPlanRevision,
          JSON.stringify(input.plan),
          input.stepCount,
        ],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: input.eventType,
        payload: input.eventPayload,
      });
      return 'ok';
    });
  }

  async finalizeAgentRun(input: FinalizeAgentRunInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';

      // Insert the single final assistant message idempotently (stable derived id).
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM messages WHERE id = $1 AND workspace_id = $2`,
        [input.assistantMessageId, input.workspaceId],
      );
      if (existing.rowCount === 0) {
        const seq = await nextSeq(tx, input.workspaceId, input.projectId, input.chatId);
        await tx.query(
          `INSERT INTO messages
             (id, workspace_id, project_id, chat_id, run_id, seq, role, text_content, content_json, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'assistant', $7, $8::jsonb, 'completed')
           ON CONFLICT (id) DO NOTHING`,
          [
            input.assistantMessageId,
            input.workspaceId,
            input.projectId,
            input.chatId,
            input.runId,
            seq,
            input.text,
            JSON.stringify({
              sha256: input.sha256,
              provider_label: input.providerLabel,
              is_mock: input.isMock,
              usage: input.usage,
              finish_reason: input.finishReason,
            }),
          ],
        );
      }

      const checkpoint = toCheckpointJson(input.checkpoint, 0);
      await tx.query(
        `UPDATE runs SET
           state = 'completed', outcome = 'complete', step_count = $5,
           runtime_owner = NULL, runtime_lease_until = NULL,
           checkpoint = ($4::jsonb
             || jsonb_build_object('active_elapsed_ms', active_elapsed_ms)),
           updated_at = now(), revision = revision + 1
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [
          input.runId,
          input.workspaceId,
          input.expectedFence,
          JSON.stringify(checkpoint),
          input.stepCount,
        ],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: 'message.committed',
        payload: {
          message_id: input.assistantMessageId,
          sha256: input.sha256,
          status: 'completed',
        },
      });
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: 'run.state_changed',
        payload: { from: 'running', to: 'completed', reason_code: null },
      });
      return 'ok';
    });
  }

  async terminateAgentRun(input: TerminateAgentRunInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';

      const checkpoint = toCheckpointJson(input.checkpoint, 0);
      await tx.query(
        `UPDATE runs SET
           state = $4, outcome = $5, stop_reason = $6,
           runtime_owner = NULL, runtime_lease_until = NULL,
           checkpoint = ($7::jsonb
             || jsonb_build_object('active_elapsed_ms', active_elapsed_ms)),
           updated_at = now(), revision = revision + 1
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [
          input.runId,
          input.workspaceId,
          input.expectedFence,
          input.state,
          input.outcome,
          input.stopReason.slice(0, 64),
          JSON.stringify(checkpoint),
        ],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: 'run.state_changed',
        payload: { from: 'running', to: input.state, reason_code: input.stopReason.slice(0, 64) },
      });
      return 'ok';
    });
  }

  async releaseLease(runId: string, workspaceId: string, expectedFence: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET runtime_owner = NULL, runtime_lease_until = NULL
       WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 AND state = 'running'`,
      [runId, workspaceId, expectedFence],
    );
  }
}

function activeRunError(): Error {
  const err = new Error('chat already has an active run') as Error & { code: string };
  err.code = '23505';
  return err;
}

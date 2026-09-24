/**
 * DB-backed {@link MessagesRepository} over `@redai/db`. Production adapter (the
 * service/runtime unit tests use the in-memory fake). It owns its SQL: every
 * statement carries an explicit `workspace_id` predicate and, for chat-level rows,
 * `project_id`/`chat_id`, so a request scoped to project A can never read or write
 * project B (INV-001), backed by the composite `(id, project_id, workspace_id)` keys.
 *
 * Durability guarantees (docs/07):
 *   - `createAskRun` reserves the idempotency key (INSERT … ON CONFLICT DO NOTHING),
 *     creates the run + user message + `run.created` event and marks the reservation
 *     completed — all in ONE transaction, so a repeated key / double-submit converges
 *     on exactly one run (the loser blocks on the unique reservation, then replays).
 *   - The lease is compare-and-set: `claimQueuedAskRun` bumps `runtime_fence` under a
 *     `FOR UPDATE SKIP LOCKED` row lock; every subsequent write is fence-guarded, so a
 *     runtime whose lease expired mid-step writes zero rows and cannot commit a
 *     duplicate final message.
 *
 * No DB transaction is held across a model call — the provider round-trip happens in
 * the service between `beginAssistantMessage`/`persistPartial` and `finalizeAssistant`
 * (architecture §6).
 */
import { appendEvent, withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
import { ChatHasActiveRunError, ChatNotFoundError, ProviderConfigNotFoundError } from './errors.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import type {
  BeginAssistantInput,
  ClaimedRun,
  CreateAskRunInput,
  CreateAskRunOutcome,
  FailRunInput,
  FenceResult,
  FinalizeAssistantInput,
  MessageRecord,
  MessagesRepository,
  Page,
  PageQuery,
  PersistPartialInput,
  RunRecord,
} from './ports.js';

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}
function pgConstraint(err: unknown): string {
  return typeof err === 'object' && err !== null
    ? String((err as { constraint?: string }).constraint ?? '')
    : '';
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

const RUN_COLS =
  'id, workspace_id, project_id, chat_id, mode, kind, state, outcome, provider_config_id, ' +
  'config_snapshot, checkpoint, runtime_owner, runtime_fence, runtime_lease_until, step_count, ' +
  'budget_limit_micro_usd, stop_reason, expires_at, revision, created_at, updated_at';

const MSG_COLS =
  'id, workspace_id, project_id, chat_id, run_id, client_message_id, seq, role, text_content, ' +
  'content_json, status, created_at';

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
  if (!row) throw new ChatNotFoundError();
  return row.message_seq;
}

export function createDbMessagesRepository(pool: Pool): MessagesRepository {
  return new DbMessagesRepository(pool);
}

class DbMessagesRepository implements MessagesRepository {
  public constructor(private readonly pool: Pool) {}

  async createAskRun(input: CreateAskRunInput): Promise<CreateAskRunOutcome> {
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

      if (reserved.rowCount === 0) {
        return this.replayIdempotent(tx, input);
      }

      // We own the reservation — run the use case, guarded by a savepoint so a
      // unique-violation (concurrent duplicate under a DIFFERENT key sharing the same
      // client_message_id) rolls back to a clean point and replays.
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
          if (!run) throw new ChatHasActiveRunError();
        } else if (pgCode(err) === FK_VIOLATION) {
          const c = pgConstraint(err);
          if (c.includes('provider')) throw new ProviderConfigNotFoundError();
          throw new ChatNotFoundError();
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
          payload: { run_id: run.id, chat_id: input.chatId },
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
    input: CreateAskRunInput,
  ): Promise<CreateAskRunOutcome> {
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

  private async insertRun(tx: Executor, input: CreateAskRunInput): Promise<RunRecord> {
    const snapshot = {
      mode: 'ask',
      objective: input.text,
      data_mode: input.dataMode,
      provider_config_id: input.providerConfigId,
      attached_artifact_ids: input.attachedArtifactIds,
      max_steps: input.maxSteps,
    };
    const res = await tx.query<RunDbRow>(
      `INSERT INTO runs
         (id, workspace_id, project_id, chat_id, mode, kind, state, provider_config_id,
          config_snapshot, budget_limit_micro_usd, expires_at)
       VALUES ($1, $2, $3, $4, 'ask', 'normal', 'queued', $5, $6::jsonb, $7, $8)
       RETURNING ${RUN_COLS}`,
      [
        input.runId,
        input.workspaceId,
        input.projectId,
        input.chatId,
        input.providerConfigId,
        JSON.stringify(snapshot),
        input.budgetLimitMicroUsd,
        input.expiresAt,
      ],
    );
    return toRun(res.rows[0]!);
  }

  private async insertUserMessage(
    tx: Executor,
    input: CreateAskRunInput,
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
    const cursorSeq = decodeCursor(page.cursor);
    const params: unknown[] = [workspaceId, projectId, chatId];
    let where = 'workspace_id = $1 AND project_id = $2 AND chat_id = $3';
    if (cursorSeq !== null) {
      params.push(cursorSeq);
      where += ` AND seq > $${params.length}`;
    }
    params.push(page.limit + 1);
    const res = await this.pool.query<MessageDbRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE ${where} ORDER BY seq ASC LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.map(toMessage);
    const hasMore = rows.length > page.limit;
    const items = hasMore ? rows.slice(0, page.limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor(last.seq) : null };
  }

  async claimQueuedAskRun(owner: string, now: Date, leaseUntil: Date): Promise<ClaimedRun | null> {
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
           WHERE mode = 'ask'
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

  async beginAssistantMessage(
    input: BeginAssistantInput,
  ): Promise<{ assistantMessageId: string; result: FenceResult }> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ checkpoint: Record<string, unknown> }>(
        `SELECT checkpoint FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return { assistantMessageId: input.assistantMessageId, result: 'stale' as const };

      const existing = g.checkpoint['assistant_message_id'];
      if (typeof existing === 'string' && existing !== '') {
        return { assistantMessageId: existing, result: 'ok' as const };
      }

      const seq = await nextSeq(tx, input.workspaceId, input.projectId, input.chatId);
      await tx.query(
        `INSERT INTO messages
           (id, workspace_id, project_id, chat_id, run_id, seq, role, text_content, content_json, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'assistant', '', $7::jsonb, 'streaming')`,
        [
          input.assistantMessageId,
          input.workspaceId,
          input.projectId,
          input.chatId,
          input.runId,
          seq,
          JSON.stringify({ generation_id: input.expectedFence, provisional: true }),
        ],
      );
      await tx.query(
        `UPDATE runs SET checkpoint = checkpoint
           || jsonb_build_object('phase', 'calling_model',
                                 'assistant_message_id', $4::text,
                                 'generation', $5::text),
           updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [
          input.runId,
          input.workspaceId,
          input.expectedFence,
          input.assistantMessageId,
          input.expectedFence,
        ],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        eventType: 'message.delta',
        payload: {
          message_id: input.assistantMessageId,
          generation_id: input.expectedFence,
          delta_seq: '0',
          text: '',
          provisional: true,
        },
      });
      return { assistantMessageId: input.assistantMessageId, result: 'ok' as const };
    });
  }

  async persistPartial(input: PersistPartialInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';
      await tx.query(
        `UPDATE messages SET text_content = $3, content_json = $4::jsonb
         WHERE id = $1 AND workspace_id = $2 AND status <> 'completed'`,
        [
          input.assistantMessageId,
          input.workspaceId,
          input.text,
          JSON.stringify({ generation_id: input.generationId, provisional: true }),
        ],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: 'message.delta',
        payload: {
          message_id: input.assistantMessageId,
          generation_id: input.generationId,
          delta_seq: '1',
          text: input.text,
          provisional: true,
        },
      });
      return 'ok';
    });
  }

  async finalizeAssistant(input: FinalizeAssistantInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string; state: string }>(
        `SELECT project_id, state FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';

      await tx.query(
        `UPDATE messages SET text_content = $3, status = 'completed', content_json = $4::jsonb
         WHERE id = $1 AND workspace_id = $2 AND status <> 'completed'`,
        [
          input.assistantMessageId,
          input.workspaceId,
          input.text,
          JSON.stringify({
            generation_id: input.generationId,
            sha256: input.sha256,
            provider_label: input.providerLabel,
            is_mock: input.isMock,
            usage: input.usage,
            finish_reason: input.finishReason,
          }),
        ],
      );
      await tx.query(
        `UPDATE runs SET state = 'completed', outcome = 'complete', step_count = step_count + 1,
           runtime_owner = NULL, runtime_lease_until = NULL,
           checkpoint = checkpoint || jsonb_build_object('phase', 'done'),
           updated_at = now(), revision = revision + 1
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [input.runId, input.workspaceId, input.expectedFence],
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

  async failRun(input: FailRunInput): Promise<FenceResult> {
    return withTransaction(this.pool, async (tx) => {
      const guard = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM runs
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3 FOR UPDATE`,
        [input.runId, input.workspaceId, input.expectedFence],
      );
      const g = guard.rows[0];
      if (!g) return 'stale';

      if (input.assistantMessageId) {
        await tx.query(
          `UPDATE messages SET status = 'interrupted'
           WHERE id = $1 AND workspace_id = $2 AND status <> 'completed'`,
          [input.assistantMessageId, input.workspaceId],
        );
      }
      await tx.query(
        `UPDATE runs SET state = 'failed', outcome = 'blocked', stop_reason = $4,
           runtime_owner = NULL, runtime_lease_until = NULL,
           updated_at = now(), revision = revision + 1
         WHERE id = $1 AND workspace_id = $2 AND runtime_fence = $3`,
        [input.runId, input.workspaceId, input.expectedFence, input.stopReason.slice(0, 64)],
      );
      await appendEvent(tx, {
        workspaceId: input.workspaceId,
        projectId: g.project_id,
        runId: input.runId,
        eventType: 'run.state_changed',
        payload: { from: 'running', to: 'failed', reason_code: input.stopReason.slice(0, 64) },
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

/**
 * In-memory {@link MessagesRepository} for the service + runtime unit tests. It
 * mirrors the DB adapter's SEMANTICS — the atomic idempotent create, the
 * one-active-run-per-chat guard, `(chat, client_message_id)` de-dup, monotonic `seq`,
 * compare-and-set lease claim and fence-guarded commits — WITHOUT a database, so the
 * fast suite exercises the same invariants the SQL enforces. The DB adapter's own
 * integration test proves the SQL matches.
 *
 * `createAskRun` runs its whole critical section SYNCHRONOUSLY (no awaits between the
 * checks and the mutation) so `Promise.all([create, create])` in a double-submit test
 * is serialised exactly as the DB adapter's single transaction serialises concurrent
 * duplicates.
 */
import { randomUUID } from 'node:crypto';
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

const ACTIVE_STATES = new Set<RunRecord['state']>([
  'queued',
  'running',
  'waiting_approval',
  'waiting_worker',
  'paused',
  'cancel_requested',
  'cancellation_pending',
  'needs_attention',
]);

interface IdemRow {
  bodySha256: string;
  runId: string;
  userMessageId: string;
}

export class InMemoryMessagesRepository implements MessagesRepository {
  private runs = new Map<string, RunRecord>();
  private messages = new Map<string, MessageRecord>();
  private chatSeq = new Map<string, bigint>();
  private idem = new Map<string, IdemRow>();

  private idemScope(k: CreateAskRunInput['idempotency']): string {
    return `${k.workspaceId}|${k.actorKey}|${k.method}|${k.route}|${k.key}`;
  }

  private nextSeq(chatId: string): string {
    const cur = this.chatSeq.get(chatId) ?? 0n;
    const next = cur + 1n;
    this.chatSeq.set(chatId, next);
    return next.toString();
  }

  private hasActiveRun(chatId: string): boolean {
    for (const r of this.runs.values()) {
      if (r.chatId === chatId && ACTIVE_STATES.has(r.state)) return true;
    }
    return false;
  }

  // NOTE: synchronous critical section (see class doc) — do not add awaits here.
  async createAskRun(input: CreateAskRunInput): Promise<CreateAskRunOutcome> {
    const scope = this.idemScope(input.idempotency);
    const existingIdem = this.idem.get(scope);
    if (existingIdem) {
      if (existingIdem.bodySha256 !== input.idempotency.bodySha256) return { kind: 'conflict' };
      const run = this.runs.get(existingIdem.runId);
      const userMessage = this.messages.get(existingIdem.userMessageId);
      if (run && userMessage) return { kind: 'replayed', run, userMessage };
      return { kind: 'in_progress' };
    }

    // Second de-dup layer: same (chat, client_message_id) → same run.
    for (const m of this.messages.values()) {
      if (
        m.chatId === input.chatId &&
        m.clientMessageId === input.clientMessageId &&
        m.role === 'user'
      ) {
        const run = m.runId ? this.runs.get(m.runId) : undefined;
        if (run) {
          this.idem.set(scope, {
            bodySha256: input.idempotency.bodySha256,
            runId: run.id,
            userMessageId: m.id,
          });
          return { kind: 'replayed', run, userMessage: m };
        }
      }
    }

    if (this.hasActiveRun(input.chatId)) throw activeRunError();

    const run: RunRecord = {
      id: input.runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      chatId: input.chatId,
      mode: 'ask',
      kind: 'normal',
      state: 'queued',
      outcome: 'none',
      providerConfigId: input.providerConfigId,
      configSnapshot: {
        mode: 'ask',
        objective: input.text,
        data_mode: input.dataMode,
        provider_config_id: input.providerConfigId,
        attached_artifact_ids: input.attachedArtifactIds,
        max_steps: input.maxSteps,
      },
      checkpoint: {},
      runtimeOwner: null,
      runtimeFence: '0',
      runtimeLeaseUntil: null,
      stepCount: 0,
      budgetLimitMicroUsd: input.budgetLimitMicroUsd,
      stopReason: null,
      expiresAt: input.expiresAt,
      revision: '1',
      createdAt: input.now,
      updatedAt: input.now,
    };
    const userMessage: MessageRecord = {
      id: input.userMessageId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      chatId: input.chatId,
      runId: input.runId,
      clientMessageId: input.clientMessageId,
      seq: this.nextSeq(input.chatId),
      role: 'user',
      textContent: input.text,
      contentJson: { attached_artifact_ids: input.attachedArtifactIds },
      status: 'completed',
      createdAt: input.now,
    };
    this.runs.set(run.id, run);
    this.messages.set(userMessage.id, userMessage);
    this.idem.set(scope, {
      bodySha256: input.idempotency.bodySha256,
      runId: run.id,
      userMessageId: userMessage.id,
    });
    return { kind: 'created', run, userMessage };
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    if (!run || run.workspaceId !== workspaceId || run.projectId !== projectId) return null;
    return run;
  }

  async listMessages(
    workspaceId: string,
    projectId: string,
    chatId: string,
    page: PageQuery,
  ): Promise<Page<MessageRecord>> {
    const all = [...this.messages.values()]
      .filter(
        (m) => m.workspaceId === workspaceId && m.projectId === projectId && m.chatId === chatId,
      )
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));

    const cursorSeq = decodeCursor(page.cursor);
    const afterCursor = cursorSeq ? all.filter((m) => BigInt(m.seq) > BigInt(cursorSeq)) : all;
    const slice = afterCursor.slice(0, page.limit);
    const last = slice[slice.length - 1];
    const nextCursor = last && slice.length < afterCursor.length ? encodeCursor(last.seq) : null;
    return { items: slice, nextCursor };
  }

  async claimQueuedAskRun(owner: string, now: Date, leaseUntil: Date): Promise<ClaimedRun | null> {
    const claimable = [...this.runs.values()]
      .filter(
        (r) =>
          r.mode === 'ask' &&
          (r.state === 'queued' ||
            (r.state === 'running' &&
              (r.runtimeLeaseUntil === null || r.runtimeLeaseUntil.getTime() < now.getTime()))),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const run = claimable[0];
    if (!run) return null;
    const fence = (BigInt(run.runtimeFence) + 1n).toString();
    const updated: RunRecord = {
      ...run,
      state: 'running',
      runtimeOwner: owner,
      runtimeFence: fence,
      runtimeLeaseUntil: leaseUntil,
      updatedAt: now,
      revision: (BigInt(run.revision) + 1n).toString(),
    };
    this.runs.set(run.id, updated);
    return { run: updated, fence };
  }

  async beginAssistantMessage(
    input: BeginAssistantInput,
  ): Promise<{ assistantMessageId: string; result: FenceResult }> {
    const run = this.runs.get(input.runId);
    if (!run || run.runtimeFence !== input.expectedFence) {
      return { assistantMessageId: input.assistantMessageId, result: 'stale' };
    }
    const existingId =
      typeof run.checkpoint['assistant_message_id'] === 'string'
        ? (run.checkpoint['assistant_message_id'] as string)
        : null;
    const messageId = existingId ?? input.assistantMessageId;
    if (!existingId) {
      const msg: MessageRecord = {
        id: messageId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        chatId: run.chatId,
        runId: run.id,
        clientMessageId: null,
        seq: this.nextSeq(run.chatId),
        role: 'assistant',
        textContent: '',
        contentJson: { generation_id: input.expectedFence, provisional: true },
        status: 'streaming',
        createdAt: input.now,
      };
      this.messages.set(msg.id, msg);
      this.runs.set(run.id, {
        ...run,
        checkpoint: {
          ...run.checkpoint,
          phase: 'calling_model',
          assistant_message_id: messageId,
          generation: input.expectedFence,
        },
        updatedAt: input.now,
      });
    }
    return { assistantMessageId: messageId, result: 'ok' };
  }

  async persistPartial(input: PersistPartialInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.runtimeFence !== input.expectedFence) return 'stale';
    const msg = this.messages.get(input.assistantMessageId);
    if (msg && msg.status !== 'completed') {
      this.messages.set(msg.id, {
        ...msg,
        textContent: input.text,
        contentJson: { generation_id: input.generationId, provisional: true },
        status: 'streaming',
      });
    }
    return 'ok';
  }

  async finalizeAssistant(input: FinalizeAssistantInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.runtimeFence !== input.expectedFence) return 'stale';
    const msg = this.messages.get(input.assistantMessageId);
    if (msg && msg.status !== 'completed') {
      this.messages.set(msg.id, {
        ...msg,
        textContent: input.text,
        status: 'completed',
        contentJson: {
          generation_id: input.generationId,
          sha256: input.sha256,
          provider_label: input.providerLabel,
          is_mock: input.isMock,
          usage: input.usage,
          finish_reason: input.finishReason,
        },
      });
    }
    this.runs.set(run.id, {
      ...run,
      state: 'completed',
      outcome: 'complete',
      stepCount: run.stepCount + 1,
      runtimeOwner: null,
      runtimeLeaseUntil: null,
      updatedAt: input.now,
      revision: (BigInt(run.revision) + 1n).toString(),
    });
    return 'ok';
  }

  async failRun(input: FailRunInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.runtimeFence !== input.expectedFence) return 'stale';
    if (input.assistantMessageId) {
      const msg = this.messages.get(input.assistantMessageId);
      if (msg && msg.status !== 'completed') {
        this.messages.set(msg.id, { ...msg, status: 'interrupted' });
      }
    }
    this.runs.set(run.id, {
      ...run,
      state: 'failed',
      outcome: 'blocked',
      stopReason: input.stopReason,
      runtimeOwner: null,
      runtimeLeaseUntil: null,
      updatedAt: input.now,
      revision: (BigInt(run.revision) + 1n).toString(),
    });
    return 'ok';
  }

  async releaseLease(runId: string, workspaceId: string, expectedFence: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.workspaceId !== workspaceId || run.runtimeFence !== expectedFence) return;
    if (run.state === 'running') {
      this.runs.set(run.id, { ...run, runtimeOwner: null, runtimeLeaseUntil: null });
    }
  }

  // --- test helpers -------------------------------------------------------
  /** Direct message lookup for assertions. */
  _message(id: string): MessageRecord | undefined {
    return this.messages.get(id);
  }
  /** All messages for a chat, ordered by seq. */
  _messagesForChat(chatId: string): MessageRecord[] {
    return [...this.messages.values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  }
  _run(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
}

function activeRunError(): Error {
  const err = new Error('chat already has an active run') as Error & { code: string };
  err.code = '23505';
  return err;
}

/** A convenience factory used by tests that want a scripted UUID source. */
export function scriptedUuids(ids: string[]): { uuid: () => string } {
  let i = 0;
  return {
    uuid: () => {
      const id = ids[i++];
      return id ?? randomUUID();
    },
  };
}

/**
 * In-memory {@link AgentRunRepository} for the service + runtime unit tests. It mirrors
 * the DB adapter's SEMANTICS — atomic idempotent create, one-active-run-per-chat guard,
 * `(chat, client_message_id)` de-dup, monotonic `seq`, compare-and-set lease claim and
 * fence-guarded checkpoint/finalize/terminate — WITHOUT a database, so the fast suite
 * exercises the same invariants the SQL enforces. `createAgentRun` runs its critical
 * section synchronously so a double-submit is serialised exactly as the DB transaction is.
 */
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

export class InMemoryAgentRunRepository implements AgentRunRepository {
  private runs = new Map<string, RunRecord>();
  private messages = new Map<string, MessageRecord>();
  private chatSeq = new Map<string, bigint>();
  private idem = new Map<string, IdemRow>();

  private idemScope(k: CreateAgentRunInput['idempotency']): string {
    return `${k.workspaceId}|${k.actorKey}|${k.method}|${k.route}|${k.key}`;
  }

  private nextSeq(chatId: string): string {
    const next = (this.chatSeq.get(chatId) ?? 0n) + 1n;
    this.chatSeq.set(chatId, next);
    return next.toString();
  }

  private hasActiveRun(chatId: string): boolean {
    for (const r of this.runs.values()) {
      if (r.chatId === chatId && ACTIVE_STATES.has(r.state)) return true;
    }
    return false;
  }

  // NOTE: synchronous critical section — do not add awaits here.
  async createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunOutcome> {
    const scope = this.idemScope(input.idempotency);
    const existingIdem = this.idem.get(scope);
    if (existingIdem) {
      if (existingIdem.bodySha256 !== input.idempotency.bodySha256) return { kind: 'conflict' };
      const run = this.runs.get(existingIdem.runId);
      const userMessage = this.messages.get(existingIdem.userMessageId);
      if (run && userMessage) return { kind: 'replayed', run, userMessage };
      return { kind: 'in_progress' };
    }

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
      mode: 'agent',
      kind: 'normal',
      state: 'queued',
      outcome: 'none',
      providerConfigId: input.providerConfigId,
      configSnapshot: {
        mode: 'agent',
        objective: input.text,
        data_mode: input.dataMode,
        provider_config_id: input.providerConfigId,
        attached_artifact_ids: input.attachedArtifactIds,
        agent_session_id: input.agentSessionId,
        max_steps: input.maxSteps,
      },
      checkpoint: {
        phase: 'planning',
        step_no: 0,
        agent_session_id: input.agentSessionId,
        objective: input.text,
        active_elapsed_ms: 0,
      },
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
    const slice = all.slice(0, page.limit);
    return { items: slice, nextCursor: null };
  }

  async claimQueuedAgentRun(
    owner: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<AgentClaimedRun | null> {
    const claimable = [...this.runs.values()]
      .filter(
        (r) =>
          r.mode === 'agent' &&
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

  private activeElapsed(run: RunRecord): number {
    const v = run.checkpoint['active_elapsed_ms'];
    return typeof v === 'number' && v >= 0 ? v : 0;
  }

  async commitCheckpoint(input: CommitCheckpointInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.runtimeFence !== input.expectedFence) {
      return 'stale';
    }
    const activeElapsed = this.activeElapsed(run) + input.activeElapsedDeltaMs;
    this.runs.set(run.id, {
      ...run,
      checkpoint: toCheckpointJson(input.checkpoint, activeElapsed),
      stepCount: input.stepCount,
      updatedAt: input.now,
      revision: (BigInt(run.revision) + 1n).toString(),
    });
    return 'ok';
  }

  async finalizeAgentRun(input: FinalizeAgentRunInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.runtimeFence !== input.expectedFence) {
      return 'stale';
    }
    const existing = this.messages.get(input.assistantMessageId);
    if (!existing) {
      this.messages.set(input.assistantMessageId, {
        id: input.assistantMessageId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        chatId: run.chatId,
        runId: run.id,
        clientMessageId: null,
        seq: this.nextSeq(run.chatId),
        role: 'assistant',
        textContent: input.text,
        contentJson: {
          sha256: input.sha256,
          provider_label: input.providerLabel,
          is_mock: input.isMock,
          usage: input.usage,
          finish_reason: input.finishReason,
        },
        status: 'completed',
        createdAt: input.now,
      });
    }
    const activeElapsed = this.activeElapsed(run);
    this.runs.set(run.id, {
      ...run,
      state: 'completed',
      outcome: 'complete',
      stepCount: input.stepCount,
      runtimeOwner: null,
      runtimeLeaseUntil: null,
      checkpoint: toCheckpointJson(input.checkpoint, activeElapsed),
      updatedAt: input.now,
      revision: (BigInt(run.revision) + 1n).toString(),
    });
    return 'ok';
  }

  async terminateAgentRun(input: TerminateAgentRunInput): Promise<FenceResult> {
    const run = this.runs.get(input.runId);
    if (!run || run.workspaceId !== input.workspaceId || run.runtimeFence !== input.expectedFence) {
      return 'stale';
    }
    const activeElapsed = this.activeElapsed(run);
    this.runs.set(run.id, {
      ...run,
      state: input.state,
      outcome: input.outcome,
      stopReason: input.stopReason,
      runtimeOwner: null,
      runtimeLeaseUntil: null,
      checkpoint: toCheckpointJson(input.checkpoint, activeElapsed),
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
  _run(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  _messagesForChat(chatId: string): MessageRecord[] {
    return [...this.messages.values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  }
  /** Force a checkpoint field (e.g. active_elapsed_ms) for a limit test. */
  _patchCheckpoint(runId: string, patch: Record<string, unknown>): void {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, checkpoint: { ...run.checkpoint, ...patch } });
  }
}

function activeRunError(): Error {
  const err = new Error('chat already has an active run') as Error & { code: string };
  err.code = '23505';
  return err;
}

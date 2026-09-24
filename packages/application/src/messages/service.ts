/**
 * Durable Ask & chat-persistence use cases (T09).
 *
 * Pure orchestration over the injected {@link MessagesRepository}, an
 * {@link AskContextBuilder}, a {@link ProviderResolver}, a {@link Clock} and a
 * {@link RandomSource}. It opens no sockets and reads no globals, so the unit tests
 * drive it with an in-memory repository and the labelled mock provider.
 *
 * Three responsibilities:
 *   1. `createAskRun` — atomically create the Run (mode='ask') + the user message +
 *      an initial event in ONE transaction, idempotent under a repeated
 *      Idempotency-Key / double-submit (returns the SAME run, never a duplicate).
 *   2. `runStep` — the durable step: build the Ask context from the CURRENT Project +
 *      SELECTED notes/files only, call the provider with an EMPTY toolset, and persist
 *      a PARTIAL then a FINAL assistant message stamped with a monotonic generation id
 *      (the lease fence), checkpointing so a crash after commit is recoverable.
 *   3. `listMessages` — chat history pagination.
 *
 * Ask creates NO worker task and NO tool output: the toolset is empty and any tool
 * calls a provider might emit are ignored — only the assistant TEXT is persisted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { assembleAskContext } from './context.js';
import { isLlmError, selectProvider } from '@redai/llm';
import type { GenerateResult, Message, ProviderCandidate, StreamEvent } from '@redai/llm';
import {
  ChatHasActiveRunError,
  IdempotencyConflictError,
  RequestInProgressError,
  RunNotFoundError,
} from './errors.js';
import type {
  AskContextBuilder,
  ClaimedRun,
  Clock,
  DataMode,
  MessageRecord,
  MessagesRepository,
  Page,
  PageQuery,
  ProviderResolver,
  RandomSource,
  RunRecord,
} from './ports.js';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** SPEC_LOCK defaults (docs/05, SPEC_LOCK.json). */
export const DEFAULT_BUDGET_MICRO_USD = '2000000';
export const DEFAULT_MAX_STEPS = 40;
export const ABSOLUTE_TIMEOUT_SECONDS = 86400;

export interface AskServiceDeps {
  repo: MessagesRepository;
  context: AskContextBuilder;
  provider: ProviderResolver;
  clock?: Clock;
  random?: RandomSource;
  defaultPageLimit?: number;
  maxPageLimit?: number;
}

/** Everything the API layer needs to reserve an idempotency key for this request. */
export interface CreateAskInput {
  workspaceId: string;
  projectId: string;
  chatId: string;
  providerConfigId: string;
  text: string;
  clientMessageId: string;
  attachedArtifactIds?: string[];
  dataMode?: DataMode;
  budgetMicroUsd?: string;
  maxSteps?: number;
  /** Idempotency scope from the HTTP layer (docs/06 §4). */
  idempotency: { actorKey: string; route: string; method: string; key: string };
}

export interface CreateAskResult {
  run: RunRecord;
  userMessage: MessageRecord;
  /** True when this call created the run; false when it replayed an existing one. */
  created: boolean;
}

export interface StepResult {
  runId: string;
  /** 'completed' | 'failed' | 'stale' (another runtime owns the lease) | 'noop'. */
  outcome: 'completed' | 'failed' | 'stale' | 'noop';
  assistantMessageId?: string;
  isMock?: boolean;
  providerLabel?: string;
}

const clampLimit = (requested: number | undefined, def: number, max: number): number => {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return def;
  return Math.min(Math.floor(requested), max);
};

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Canonical JSON digest of the request body for idempotency-body matching (docs/06 §4). */
export function canonicalBodyHash(body: Record<string, unknown>): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return sha256Hex(JSON.stringify(sortValue(body)));
}

export class AskService {
  private readonly repo: MessagesRepository;
  private readonly context: AskContextBuilder;
  private readonly provider: ProviderResolver;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly defaultPageLimit: number;
  private readonly maxPageLimit: number;

  public constructor(deps: AskServiceDeps) {
    this.repo = deps.repo;
    this.context = deps.context;
    this.provider = deps.provider;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.random = deps.random ?? { uuid: () => randomUUID() };
    this.defaultPageLimit = deps.defaultPageLimit ?? DEFAULT_PAGE_LIMIT;
    this.maxPageLimit = deps.maxPageLimit ?? MAX_PAGE_LIMIT;
  }

  /**
   * Atomically create the Ask run + user message + initial event. Idempotent: a
   * repeated Idempotency-Key with the same body, or a double-submit with the same
   * `client_message_id`, returns the SAME run rather than creating a duplicate. The
   * atomicity + serialisation live in the repository (one DB transaction / one
   * synchronous critical section), so two concurrent submits converge on one run.
   */
  async createAskRun(input: CreateAskInput, bodySha256: string): Promise<CreateAskResult> {
    const now = this.clock.now();
    const outcome = await this.repo.createAskRun({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      chatId: input.chatId,
      runId: this.random.uuid(),
      userMessageId: this.random.uuid(),
      providerConfigId: input.providerConfigId,
      text: input.text,
      clientMessageId: input.clientMessageId,
      attachedArtifactIds: input.attachedArtifactIds ?? [],
      dataMode: input.dataMode ?? 'redacted_cloud',
      budgetLimitMicroUsd: input.budgetMicroUsd ?? DEFAULT_BUDGET_MICRO_USD,
      maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
      expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_SECONDS * 1000),
      now,
      idempotency: {
        workspaceId: input.workspaceId,
        actorKey: input.idempotency.actorKey,
        method: input.idempotency.method,
        route: input.idempotency.route,
        key: input.idempotency.key,
        bodySha256,
        expiresAt: new Date(now.getTime() + 86400 * 1000),
      },
    });

    switch (outcome.kind) {
      case 'created':
        return { run: outcome.run, userMessage: outcome.userMessage, created: true };
      case 'replayed':
        return { run: outcome.run, userMessage: outcome.userMessage, created: false };
      case 'conflict':
        throw new IdempotencyConflictError();
      case 'in_progress':
        throw new RequestInProgressError();
      default: {
        const never: never = outcome;
        throw new Error(`unreachable createAskRun outcome: ${JSON.stringify(never)}`);
      }
    }
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord> {
    const run = await this.repo.getRun(workspaceId, projectId, runId);
    if (!run) throw new RunNotFoundError();
    return run;
  }

  async listMessages(
    workspaceId: string,
    projectId: string,
    chatId: string,
    page: PageQuery,
  ): Promise<Page<MessageRecord>> {
    const limit = clampLimit(page.limit, this.defaultPageLimit, this.maxPageLimit);
    return this.repo.listMessages(workspaceId, projectId, chatId, {
      limit,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    });
  }

  /**
   * The durable Ask step against an already-CLAIMED run. Fence-guarded throughout:
   * every write is conditional on the run still carrying `claimed.fence`, so a stale
   * runtime that resumes after its lease expired writes ZERO rows and cannot commit a
   * duplicate final message (docs/07 §10 acceptance). The generation id is the fence,
   * stamped on the provisional and final messages.
   */
  async runStep(claimed: ClaimedRun): Promise<StepResult> {
    const run = claimed.run;
    const fence = claimed.fence;

    // Recover the assistant-message id from the checkpoint, or allocate a fresh one.
    const existingId = readCheckpointString(run.checkpoint, 'assistant_message_id');
    const assistantMessageId = existingId ?? this.random.uuid();

    const begin = await this.repo.beginAssistantMessage({
      runId: run.id,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      chatId: run.chatId,
      expectedFence: fence,
      assistantMessageId,
      now: this.clock.now(),
    });
    if (begin.result === 'stale') return { runId: run.id, outcome: 'stale' };
    const messageId = begin.assistantMessageId;

    // Build the Ask context from the CURRENT Project + SELECTED notes/files only.
    const inputs = await this.context.build(
      run.workspaceId,
      run.projectId,
      run.chatId,
      readAttachedArtifactIds(run.configSnapshot),
      run.id,
    );
    const objective = readCheckpointString(run.configSnapshot, 'objective') ?? '';
    const messages = assembleAskContext(inputs, objective);

    // Resolve the provider (data-mode routing) and generate with an EMPTY toolset.
    const { candidates, dataMode } = await this.provider.resolve(run);
    let result: GenerateResult;
    try {
      result = await this.generate(candidates, messages, dataMode);
    } catch (err) {
      const stopReason = isLlmError(err) ? err.code : 'MODEL_ERROR';
      const failed = await this.repo.failRun({
        runId: run.id,
        workspaceId: run.workspaceId,
        assistantMessageId: messageId,
        expectedFence: fence,
        stopReason,
        now: this.clock.now(),
      });
      if (failed === 'stale') return { runId: run.id, outcome: 'stale' };
      return { runId: run.id, outcome: 'failed', assistantMessageId: messageId };
    }

    // Persist a PARTIAL snapshot (provisional), then the FINAL committed message.
    const partial = await this.repo.persistPartial({
      runId: run.id,
      workspaceId: run.workspaceId,
      assistantMessageId: messageId,
      expectedFence: fence,
      text: result.text,
      generationId: fence,
      now: this.clock.now(),
    });
    if (partial === 'stale') return { runId: run.id, outcome: 'stale' };

    const finalized = await this.repo.finalizeAssistant({
      runId: run.id,
      workspaceId: run.workspaceId,
      assistantMessageId: messageId,
      expectedFence: fence,
      text: result.text,
      sha256: sha256Hex(result.text),
      generationId: fence,
      providerLabel: result.providerLabel,
      isMock: result.isMock,
      usage: result.usage,
      finishReason: result.finishReason,
      now: this.clock.now(),
    });
    if (finalized === 'stale') return { runId: run.id, outcome: 'stale' };

    return {
      runId: run.id,
      outcome: 'completed',
      assistantMessageId: messageId,
      isMock: result.isMock,
      providerLabel: result.providerLabel,
    };
  }

  /**
   * One provider round-trip with an EMPTY toolset. Uses the streaming transport to
   * accumulate text (so a real provider streams provisional tokens) but tool-call
   * chunks are IGNORED — Ask has no tools, so a provider that scripts tool calls
   * never produces an executable call or a tool result in an Ask.
   */
  private async generate(
    candidates: ProviderCandidate[],
    messages: Message[],
    dataMode: DataMode,
  ): Promise<GenerateResult> {
    const candidate = selectProvider(candidates, dataMode);
    const provider = candidate.provider;

    // Prefer streaming when supported so provisional text is produced incrementally;
    // fall back to a single aggregated generate otherwise. Either way tools=[] .
    if (provider.info.capabilities.streaming) {
      let text = '';
      let usage: GenerateResult['usage'] = { kind: 'unknown' };
      let finishReason: GenerateResult['finishReason'] = 'stop';
      for await (const ev of provider.stream({ messages, tools: [], dataMode, stream: true })) {
        const e: StreamEvent = ev;
        if (e.type === 'text') text += e.text;
        else if (e.type === 'usage') usage = e.usage;
        else if (e.type === 'finish') finishReason = e.finishReason;
        // tool_call events are intentionally ignored: Ask has no toolset.
      }
      return {
        text,
        usage,
        finishReason,
        isMock: provider.info.isMock,
        providerLabel: provider.info.label,
      };
    }

    const result = await provider.generate({ messages, tools: [], dataMode });
    // Defence in depth: never surface tool calls from an Ask result.
    return {
      text: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
      isMock: result.isMock,
      providerLabel: result.providerLabel,
    };
  }
}

function readCheckpointString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function readAttachedArtifactIds(snapshot: Record<string, unknown>): string[] {
  const v = snapshot['attached_artifact_ids'];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Re-export so callers avoid importing `ChatHasActiveRunError` from two places. */
export { ChatHasActiveRunError };

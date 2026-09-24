/**
 * Injected collaborators and storage/provider/context ports for the durable Ask &
 * chat-persistence use cases (T09).
 *
 * The use cases are pure orchestration over these ports plus a {@link Clock} and a
 * {@link RandomSource}, so the unit tests drive them with an in-memory repository, a
 * scripted UUID source and the labelled mock provider, while the DB adapter wires the
 * real `pg` pool and the runtime driver wires a resolver built from T05
 * `resolveCredential` + T08 providers. No `pg` / `@redai/db` type leaks across this
 * boundary — records are DB-shape-neutral (camelCase; bigint columns as decimal
 * strings per docs/05 §1). Every read/write is scoped by `(workspaceId, projectId,
 * chatId)` so a foreign id resolves to NotFound, never a cross-project read (INV-001).
 */
import type { DataMode, GenerateResult, ProviderCandidate } from '@redai/llm';

/** Monotonic source of "now"; the only way a use case learns the wall clock. */
export interface Clock {
  now(): Date;
}

/** Cryptographically strong randomness. Only UUIDs are needed by these use cases. */
export interface RandomSource {
  /** A random UUID (v4) for a new run/message primary key. */
  uuid(): string;
}

export type RunMode = 'ask' | 'agent';
export type RunKind = 'normal' | 'retest';
export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_worker'
  | 'paused'
  | 'cancel_requested'
  | 'cancellation_pending'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';
export type RunOutcome = 'none' | 'complete' | 'partial' | 'blocked';
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'interrupted';

/** DB-shape-neutral run row (only the columns the Ask use cases need). */
export interface RunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  chatId: string;
  mode: RunMode;
  kind: RunKind;
  state: RunState;
  outcome: RunOutcome;
  providerConfigId: string;
  configSnapshot: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  runtimeOwner: string | null;
  /** bigint as a decimal string (docs/05 §1). Increments on every lease claim. */
  runtimeFence: string;
  runtimeLeaseUntil: Date | null;
  stepCount: number;
  budgetLimitMicroUsd: string;
  stopReason: string | null;
  expiresAt: Date;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  chatId: string;
  runId: string | null;
  clientMessageId: string | null;
  /** bigint as a decimal string. */
  seq: string;
  role: MessageRole;
  textContent: string;
  contentJson: Record<string, unknown>;
  status: MessageStatus;
  createdAt: Date;
}

export interface PageQuery {
  limit: number;
  cursor?: string | undefined;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Input to the atomic create-Ask use case (run + user message + event in ONE txn). */
export interface CreateAskRunInput {
  workspaceId: string;
  projectId: string;
  chatId: string;
  /** Pre-allocated run id (from the service's RandomSource). */
  runId: string;
  /** Pre-allocated user-message id. */
  userMessageId: string;
  providerConfigId: string;
  /** The user's prompt text (the run objective). */
  text: string;
  /** Client-supplied de-dup id; UNIQUE (chat_id, client_message_id) backs idempotency. */
  clientMessageId: string;
  /** Artifact ids the owner attached as Ask context (SELECTED files only). */
  attachedArtifactIds: string[];
  dataMode: DataMode;
  budgetLimitMicroUsd: string;
  maxSteps: number;
  expiresAt: Date;
  now: Date;
  /** Idempotency reservation (docs/06 §4). */
  idempotency: IdempotencyKey;
}

/** The `(actor, method, route, key)` scope + canonical body digest (docs/06 §4). */
export interface IdempotencyKey {
  workspaceId: string;
  actorKey: string;
  method: string;
  route: string;
  key: string;
  bodySha256: string;
  expiresAt: Date;
}

/**
 * Outcome of {@link MessagesRepository.createAskRun}. `created` ran the use case;
 * `replayed` returned the previously-committed run for the same idempotency
 * key/body OR the same `(chat, client_message_id)`; `conflict` is a reused key with a
 * different body; `in_progress` is a concurrent duplicate still committing.
 */
export type CreateAskRunOutcome =
  | { kind: 'created'; run: RunRecord; userMessage: MessageRecord }
  | { kind: 'replayed'; run: RunRecord; userMessage: MessageRecord }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

/** A run claimed by the runtime, carrying the fence it must fence-guard writes with. */
export interface ClaimedRun {
  run: RunRecord;
  /** The new fence after the claim (equals `run.runtimeFence`). */
  fence: string;
}

export interface BeginAssistantInput {
  runId: string;
  workspaceId: string;
  projectId: string;
  chatId: string;
  expectedFence: string;
  assistantMessageId: string;
  now: Date;
}

export interface PersistPartialInput {
  runId: string;
  workspaceId: string;
  assistantMessageId: string;
  expectedFence: string;
  text: string;
  generationId: string;
  now: Date;
}

export interface FinalizeAssistantInput {
  runId: string;
  workspaceId: string;
  assistantMessageId: string;
  expectedFence: string;
  text: string;
  sha256: string;
  generationId: string;
  providerLabel: string;
  isMock: boolean;
  usage: GenerateResult['usage'];
  finishReason: GenerateResult['finishReason'];
  now: Date;
}

export interface FailRunInput {
  runId: string;
  workspaceId: string;
  assistantMessageId: string | null;
  expectedFence: string;
  stopReason: string;
  now: Date;
}

/** A fence-guarded write result. `stale` means another runtime holds the lease. */
export type FenceResult = 'ok' | 'stale';

/**
 * Storage port for runs + chat messages + the idempotency ledger + the durable-step
 * lease. `createAskRun` is a SINGLE atomic operation (idempotency reservation +
 * dedup + insert + event) so both the DB adapter (one transaction) and the in-memory
 * fake (one synchronous critical section) guarantee exactly-one-run under a repeated
 * key or a double-submit. The lease/fence methods implement compare-and-set claim and
 * fence-guarded commits so a resumed runtime never duplicates the final message.
 */
export interface MessagesRepository {
  createAskRun(input: CreateAskRunInput): Promise<CreateAskRunOutcome>;
  getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord | null>;
  listMessages(
    workspaceId: string,
    projectId: string,
    chatId: string,
    page: PageQuery,
  ): Promise<Page<MessageRecord>>;

  /** CAS-claim the oldest claimable Ask run (queued, or running with an expired lease). */
  claimQueuedAskRun(owner: string, now: Date, leaseUntil: Date): Promise<ClaimedRun | null>;

  /** Persist (or recover) the provisional assistant message; guarded by the fence. */
  beginAssistantMessage(
    input: BeginAssistantInput,
  ): Promise<{ assistantMessageId: string; result: FenceResult }>;

  /** Persist a provisional partial snapshot of the assistant text; fence-guarded. */
  persistPartial(input: PersistPartialInput): Promise<FenceResult>;

  /** Commit the final assistant message + complete the run; fence-guarded, idempotent. */
  finalizeAssistant(input: FinalizeAssistantInput): Promise<FenceResult>;

  /** Mark the run failed and the partial message interrupted; fence-guarded. */
  failRun(input: FailRunInput): Promise<FenceResult>;

  /** Release the lease without changing terminal state (runtime giving up its turn). */
  releaseLease(runId: string, workspaceId: string, expectedFence: string): Promise<void>;
}

/** Raw context inputs the builder reads for an Ask (SELECTED notes/files + history). */
export interface AskContextInputs {
  selectedNotes: { id: string; title: string; content: string }[];
  attachedFiles: { id: string; filename: string; mediaType: string }[];
  /** Prior chat messages (completed only), oldest-first, EXCLUDING the in-flight turn. */
  history: { role: MessageRole; text: string }[];
}

/**
 * Reads the Ask context from the CURRENT Project only: notes with
 * `selected_for_context = true` and the artifacts the owner attached to THIS run
 * (docs/11 §4). Injected so the unit tests supply deterministic inputs and the DB
 * adapter reaches the projects/artifacts repositories.
 */
export interface AskContextBuilder {
  build(
    workspaceId: string,
    projectId: string,
    chatId: string,
    attachedArtifactIds: string[],
    /** The current run whose in-flight messages (objective + streaming reply) are excluded. */
    excludeRunId: string,
  ): Promise<AskContextInputs>;
}

/**
 * Resolves the provider candidates + data mode for a run. The production
 * implementation composes a T08 provider from the run's provider config and the T05
 * `resolveCredential` key; tests inject one returning the labelled mock. Ask NEVER
 * passes a toolset, so the candidate's tool capability is irrelevant here.
 */
export interface ProviderResolver {
  resolve(run: RunRecord): Promise<{ candidates: ProviderCandidate[]; dataMode: DataMode }>;
}

/** Re-exported neutral gateway types the runtime driver and API layer consume. */
export type { DataMode, Message, ProviderCandidate, GenerateResult } from '@redai/llm';

/**
 * Ports for the durable Agent loop (T13). The service is pure orchestration over these
 * collaborators plus a {@link Clock} and {@link RandomSource}, so the unit tests drive
 * it with an in-memory repository, the labelled mock provider and a MOCK tool
 * transport, while the DB adapter wires the real `pg` pool.
 *
 * Reuses the T09 neutral record shapes ({@link RunRecord}, {@link MessageRecord}) — an
 * Agent run is the SAME `runs` row (mode='agent') and its assistant messages the same
 * `messages` rows — so the two runtimes share persistence semantics (fence, checkpoint,
 * events) without a second run table.
 */
import type { DataMode } from '@redai/llm';
import type { StepPhase } from '@redai/domain';
import type { FingerprintRecord } from '@redai/domain';
import type {
  MessageRecord,
  RunRecord,
  FenceResult,
  Page,
  PageQuery,
  Clock,
  RandomSource,
} from '../messages/ports.js';

export type { MessageRecord, RunRecord, FenceResult, Page, PageQuery, Clock, RandomSource };

/** Effect class of a tool, classified SERVER-SIDE from the registry (never the model). */
export type EffectClass =
  'pure' | 'sandbox_write' | 'external_read' | 'external_write' | 'destructive' | 'unknown';

/** A run claimed by the Agent runtime, carrying the fence its writes must guard on. */
export interface AgentClaimedRun {
  run: RunRecord;
  fence: string;
}

/** A logical tool call the model requested this step, with a STABLE id (docs/07 §4). */
export interface PendingToolCall {
  /** Stable logical id derived from (runId, stepNo, providerToolIndex). */
  id: string;
  providerToolIndex: number;
  stepNo: number;
  name: string;
  /** Canonical JSON of the validated arguments. */
  argumentsJson: string;
  argumentsSha256: string;
  /** Server-classified effect (from the registry). */
  effectClass: EffectClass;
  target: string | null;
  fingerprint: string;
  /**
   * Two-phase execution flag: set true (committed) BEFORE the seam dispatch, so a
   * crash after dispatch-but-before-result does NOT re-dispatch (docs/07 §5).
   */
  dispatched: boolean;
}

/** The result the tool transport (mock here; T17 worker path in production) returned. */
export interface ToolResultRecord {
  toolCallId: string;
  ok: boolean;
  resultSha256: string;
  summary: string;
  /** Whether the effect is known to have completed (docs/07 §5, §9). */
  effectObservation: 'not_started' | 'completed' | 'unknown';
}

/** The durable checkpoint the Agent loop reads/writes (subset of docs/07 §3). */
export interface AgentCheckpoint {
  phase: StepPhase;
  stepNo: number;
  agentSessionId: string;
  objective: string;
  providerRequestId: string | null;
  /** Bounded context manifest: selected note/file ids + hashes (no secrets). */
  contextManifest: { noteIds: string[]; artifactIds: string[] };
  pendingToolCalls: PendingToolCall[];
  toolResults: Record<string, ToolResultRecord>;
  fingerprints: FingerprintRecord[];
  /** Last result sha per action fingerprint — an unchanged sha means "no progress". */
  lastResultShaByFingerprint: Record<string, string>;
  /** The single assistant-message row id for the final answer (stable across resume). */
  assistantMessageId: string | null;
  stopReason: string | null;
}

/** Input to create (queue) an Agent run — mirrors the Ask create contract. */
export interface CreateAgentRunInput {
  workspaceId: string;
  projectId: string;
  chatId: string;
  runId: string;
  userMessageId: string;
  agentSessionId: string;
  providerConfigId: string;
  text: string;
  clientMessageId: string;
  attachedArtifactIds: string[];
  dataMode: DataMode;
  budgetLimitMicroUsd: string;
  maxSteps: number;
  expiresAt: Date;
  now: Date;
  idempotency: {
    workspaceId: string;
    actorKey: string;
    method: string;
    route: string;
    key: string;
    bodySha256: string;
    expiresAt: Date;
  };
}

export type CreateAgentRunOutcome =
  | { kind: 'created'; run: RunRecord; userMessage: MessageRecord }
  | { kind: 'replayed'; run: RunRecord; userMessage: MessageRecord }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

/** Fence-guarded checkpoint commit — run stays active; state may move within it. */
export interface CommitCheckpointInput {
  runId: string;
  workspaceId: string;
  expectedFence: string;
  checkpoint: AgentCheckpoint;
  /** Persisted to the `plan` jsonb column; `planRevision` bumps monotonically. */
  plan: unknown[];
  bumpPlanRevision: boolean;
  /** Absolute step counter; NEVER decreases (docs/07 §9). */
  stepCount: number;
  /** Delta added to `active_elapsed_ms`. */
  activeElapsedDeltaMs: number;
  /** Optional non-terminal state move (e.g. running→needs_attention is terminal-ish). */
  eventType: string;
  eventPayload: Record<string, unknown>;
  now: Date;
}

/** Fence-guarded finalize: write the single final assistant message + complete run. */
export interface FinalizeAgentRunInput {
  runId: string;
  workspaceId: string;
  projectId: string;
  chatId: string;
  expectedFence: string;
  assistantMessageId: string;
  text: string;
  sha256: string;
  providerLabel: string;
  isMock: boolean;
  usage: unknown;
  finishReason: string;
  checkpoint: AgentCheckpoint;
  plan: unknown[];
  stepCount: number;
  now: Date;
}

/** Fence-guarded terminal move that is NOT a success (failed/needs_attention/etc.). */
export interface TerminateAgentRunInput {
  runId: string;
  workspaceId: string;
  expectedFence: string;
  state: 'failed' | 'needs_attention' | 'expired' | 'canceled';
  outcome: 'none' | 'partial' | 'blocked';
  stopReason: string;
  checkpoint: AgentCheckpoint;
  now: Date;
}

/**
 * Storage port for the Agent loop. `createAgentRun` is one atomic idempotent op (run +
 * user message + event). The lease/checkpoint/finalize/terminate methods are
 * compare-and-set on `runtime_fence`, so a runtime whose lease expired writes zero rows
 * and can neither dispatch a duplicate logical call nor commit a duplicate final
 * message (docs/07 §10).
 */
export interface AgentRunRepository {
  createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunOutcome>;
  getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord | null>;
  listMessages(
    workspaceId: string,
    projectId: string,
    chatId: string,
    page: PageQuery,
  ): Promise<Page<MessageRecord>>;
  /** CAS-claim the oldest claimable agent run (queued, or running with an expired lease). */
  claimQueuedAgentRun(owner: string, now: Date, leaseUntil: Date): Promise<AgentClaimedRun | null>;
  commitCheckpoint(input: CommitCheckpointInput): Promise<FenceResult>;
  finalizeAgentRun(input: FinalizeAgentRunInput): Promise<FenceResult>;
  terminateAgentRun(input: TerminateAgentRunInput): Promise<FenceResult>;
  releaseLease(runId: string, workspaceId: string, expectedFence: string): Promise<void>;
}

/**
 * A model-requested tool call the runtime is about to authorize + dispatch. `arguments`
 * is the parsed, schema-validated arguments; `effectClass` is the SERVER classification.
 */
export interface ToolDispatchRequest {
  toolCallId: string;
  attemptId: string;
  /** The current runtime fence, used as the per-attempt fencing token. */
  fencingToken: string;
  toolName: string;
  arguments: unknown;
  effectClass: EffectClass;
  target: string | null;
}

/**
 * The dispatch SEAM. In T13 the runtime injects a MOCK transport (deterministic, no
 * network). T17 replaces this with the scheduler that creates a real `task_attempts`
 * row, signs a lease and awaits a worker result. The production T13 wiring injects a
 * transport that throws {@link ToolDispatchUnavailableError}, so a real agent run parks
 * at the dispatch boundary rather than performing any real effect.
 */
export interface ToolTransport {
  dispatch(req: ToolDispatchRequest): Promise<ToolResultRecord>;
}

/** Thrown by the production T13 seam: real dispatch is T17 (no effect is performed). */
export class ToolDispatchUnavailableError extends Error {
  public constructor(toolName: string) {
    super(`tool dispatch for "${toolName}" is not available until T17 (scheduler + sandbox)`);
    this.name = 'ToolDispatchUnavailableError';
  }
}

/** A registered tool: its contract key + SERVER effect classification (docs/07 §1). */
export interface ToolRegistryEntry {
  name: string;
  contractKey: import('@redai/contracts').ContractKey;
  effectClass: EffectClass;
  description: string;
  /** JSON-Schema parameters handed to the provider (native tool calling only). */
  parameters: Record<string, unknown>;
  /** Extract the effect target (host/path/artifact) from validated args, for fingerprints. */
  target(args: unknown): string | null;
}

export interface ToolRegistry {
  /** Neutral tool definitions handed to the model gateway. */
  definitions(): { name: string; description: string; parameters: Record<string, unknown> }[];
  lookup(name: string): ToolRegistryEntry | undefined;
}

/**
 * Authorizes a model-requested tool call BEFORE dispatch (the model never grants
 * permission — docs/16 TH01). The production authorizer consults @redai/policy (T12)
 * against the run's scope snapshot + live grant; a deny yields a blocked item and NO
 * dispatch. Injected so the loop tests can use a deterministic authorizer.
 */
export interface ToolAuthorizer {
  authorize(input: {
    run: RunRecord;
    toolName: string;
    effectClass: EffectClass;
    target: string | null;
    arguments: unknown;
  }): Promise<{ verdict: 'allow' | 'ask' | 'deny'; reasonCode: string }>;
}

/** Raw context inputs for an Agent step (selected notes/files + prior chat history). */
export interface AgentContextInputs {
  selectedNotes: { id: string; title: string; content: string }[];
  attachedFiles: { id: string; filename: string; mediaType: string }[];
  history: { role: 'user' | 'assistant' | 'system'; text: string }[];
}

export interface AgentContextBuilder {
  build(
    workspaceId: string,
    projectId: string,
    chatId: string,
    attachedArtifactIds: string[],
    excludeRunId: string,
  ): Promise<AgentContextInputs>;
}

/** Resolves provider candidates + data mode for an agent run (shared with T09). */
export type { ProviderResolver } from '../messages/ports.js';

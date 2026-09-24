/**
 * Durable Agent loop use cases (T13). Pure orchestration over the injected
 * {@link AgentRunRepository}, {@link ProviderResolver}, {@link ToolTransport} (the
 * dispatch SEAM), {@link ToolRegistry}, {@link ToolAuthorizer} and a
 * {@link AgentContextBuilder}, plus a {@link Clock} and {@link RandomSource}. It opens
 * no sockets and holds NO DB transaction across the model call.
 *
 * `runStep` advances an already-CLAIMED agent run by ONE checkpoint phase and commits
 * fence-guarded, so a crash resumes from the last committed phase:
 *   - `planning`         → call the model WITH the toolset, parse the (untrusted) plan
 *                          and tool calls, validate + classify + authorize each call
 *                          SERVER-SIDE, allocate STABLE logical ids, run loop/limit
 *                          checks, and either FINALIZE (no tools) or commit
 *                          `model_committed` with the pending logical calls.
 *   - `model_committed`  → dispatch each pending call EXACTLY ONCE via the seam
 *                          (two-phase: commit intent, dispatch, commit result), then
 *                          settle back to `planning` feeding the results in.
 *
 * A malformed/invalid model response NEVER produces a tool dispatch — it terminates the
 * run at `needs_attention` (docs/07 §4, §9). Two runtimes racing: the stale fence's
 * commit is rejected, so exactly one advances (docs/07 §10).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  checkLimits,
  computeFingerprint,
  finalMessageId,
  isLoopDetected,
  logicalToolCallId,
  parsePlanFromText,
  toolAttemptId,
} from '@redai/domain';
import type { FingerprintRecord, StepPhase } from '@redai/domain';
import { isLlmError, selectProvider, validateToolCall } from '@redai/llm';
import type { GenerateResult, Message } from '@redai/llm';
import { assembleAgentContext } from './context.js';
import { DEFAULT_TOOL_REGISTRY } from './registry.js';
import { ToolDispatchUnavailableError } from './ports.js';
import type {
  AgentCheckpoint,
  AgentClaimedRun,
  AgentContextBuilder,
  AgentRunRepository,
  Clock,
  CreateAgentRunInput,
  CreateAgentRunOutcome,
  PendingToolCall,
  ProviderResolver,
  RandomSource,
  RunRecord,
  ToolAuthorizer,
  ToolRegistry,
  ToolResultRecord,
  ToolTransport,
} from './ports.js';

export const DEFAULT_MAX_STEPS = 40;
export const ABSOLUTE_TIMEOUT_SECONDS = 86400;

/** Reason codes the loop stamps on a non-success terminal state. */
export type AgentStopReason =
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_ERROR'
  | 'UNKNOWN_TOOL'
  | 'POLICY_DENIED'
  | 'WAITING_APPROVAL'
  | 'WAITING_DISPATCH'
  | 'TOOL_RESULT_UNKNOWN'
  | 'LOOP_DETECTED'
  | 'MAX_STEPS'
  | 'ACTIVE_TIMEOUT'
  | 'ABSOLUTE_TIMEOUT';

export interface AgentStepResult {
  runId: string;
  outcome:
    | 'stepped'
    | 'completed'
    | 'failed'
    | 'needs_attention'
    | 'expired'
    | 'canceled'
    | 'stale'
    | 'noop';
  assistantMessageId?: string;
  stopReason?: AgentStopReason;
  /** Logical tool-call ids dispatched during THIS tick (telemetry / test assertions). */
  dispatched?: string[];
}

export interface AgentServiceDeps {
  repo: AgentRunRepository;
  context: AgentContextBuilder;
  provider: ProviderResolver;
  transport: ToolTransport;
  authorizer: ToolAuthorizer;
  registry?: ToolRegistry;
  clock?: Clock;
  random?: RandomSource;
  /** Active-time attributed per step (ms). Tests pass 0 to keep the clock still. */
  activeMsPerStep?: number;
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Stable canonical JSON so equal argument objects hash identically. */
export function canonicalJson(value: unknown): string {
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
  return JSON.stringify(sortValue(value));
}

export class AgentService {
  private readonly repo: AgentRunRepository;
  private readonly context: AgentContextBuilder;
  private readonly provider: ProviderResolver;
  private readonly transport: ToolTransport;
  private readonly authorizer: ToolAuthorizer;
  private readonly registry: ToolRegistry;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly activeMsPerStep: number;

  public constructor(deps: AgentServiceDeps) {
    this.repo = deps.repo;
    this.context = deps.context;
    this.provider = deps.provider;
    this.transport = deps.transport;
    this.authorizer = deps.authorizer;
    this.registry = deps.registry ?? DEFAULT_TOOL_REGISTRY;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.random = deps.random ?? { uuid: () => randomUUID() };
    this.activeMsPerStep = deps.activeMsPerStep ?? 0;
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<CreateAgentRunOutcome> {
    return this.repo.createAgentRun(input);
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<RunRecord | null> {
    return this.repo.getRun(workspaceId, projectId, runId);
  }

  /** Advance a claimed agent run by one checkpoint phase; fence-guarded throughout. */
  async runStep(claimed: AgentClaimedRun): Promise<AgentStepResult> {
    const run = claimed.run;
    const fence = claimed.fence;
    const cp = readCheckpoint(run);
    const now = this.clock.now();

    // Limit gate first (pure domain): stop before spending another model call.
    const stop = checkLimits({
      stepCount: run.stepCount,
      activeElapsedMs: readActiveElapsed(run),
      createdAt: run.createdAt,
      now,
      maxSteps: readMaxSteps(run),
    });
    if (stop) {
      const state = stop === 'ABSOLUTE_TIMEOUT' ? 'expired' : 'failed';
      const r = await this.repo.terminateAgentRun({
        runId: run.id,
        workspaceId: run.workspaceId,
        expectedFence: fence,
        state,
        outcome: 'partial',
        stopReason: stop,
        checkpoint: { ...cp, stopReason: stop },
        now,
      });
      if (r === 'stale') return { runId: run.id, outcome: 'stale' };
      return {
        runId: run.id,
        outcome: state === 'expired' ? 'expired' : 'failed',
        stopReason: stop,
      };
    }

    switch (cp.phase) {
      case 'planning':
      case 'calling_model':
        return this.planStep(run, fence, cp, now);
      case 'model_committed':
        return this.dispatchStep(run, fence, cp, now);
      case 'done':
      default:
        return { runId: run.id, outcome: 'noop' };
    }
  }

  // ------------------------------------------------------------ planning phase

  private async planStep(
    run: RunRecord,
    fence: string,
    cp: AgentCheckpoint,
    now: Date,
  ): Promise<AgentStepResult> {
    const stepNo = run.stepCount + 1;
    const objective = cp.objective || readObjective(run);

    const inputs = await this.context.build(
      run.workspaceId,
      run.projectId,
      run.chatId,
      readAttachedArtifactIds(run.configSnapshot),
      run.id,
    );
    const priorResults = Object.values(cp.toolResults);
    const messages = assembleAgentContext(inputs, objective, priorResults);
    const providerRequestId = this.random.uuid();

    // Provider round-trip WITH the toolset. A malformed tool-call frame (bad JSON,
    // conflicting indices) throws in the gateway assembler → NO dispatch.
    let result: GenerateResult;
    try {
      const { candidates, dataMode } = await this.provider.resolve(run);
      const candidate = selectProvider(candidates, dataMode);
      result = await candidate.provider.generate({
        messages,
        tools: this.registry.definitions(),
        dataMode,
      });
    } catch (err) {
      // A malformed model output (bad tool JSON, conflicting/duplicate tool indices) is
      // an LLM_PROTOCOL error → MODEL_OUTPUT_INVALID; any other LLM error → MODEL_ERROR.
      // Match on the stable error CODE, never `instanceof` (robust across module realms).
      const reason: AgentStopReason =
        isLlmError(err) && err.code === 'LLM_PROTOCOL' ? 'MODEL_OUTPUT_INVALID' : 'MODEL_ERROR';
      return this.parkNeedsAttention(run, fence, cp, reason, now);
    }

    // The plan is untrusted: a present-but-malformed plan is rejected (no dispatch).
    const planRes = parsePlanFromText(result.text);
    if (!planRes.ok) {
      return this.parkNeedsAttention(run, fence, cp, 'MODEL_OUTPUT_INVALID', now);
    }

    const toolCalls = result.toolCalls ?? [];

    // Finalization gate: no tool calls requested + no unresolved pending tools ⇒ finish.
    if (toolCalls.length === 0) {
      return this.finalize(run, fence, cp, result, planRes.plan, stepNo, now);
    }

    // Validate + classify + authorize each requested call SERVER-SIDE (model can't grant).
    const inputVersions = contextVersions(inputs);
    const pending: PendingToolCall[] = [];
    for (const call of toolCalls) {
      const entry = this.registry.lookup(call.name);
      if (!entry) return this.parkNeedsAttention(run, fence, cp, 'UNKNOWN_TOOL', now, 'blocked');

      const validation = validateToolCall(entry.contractKey, call);
      if (!validation.ok) {
        return this.parkNeedsAttention(run, fence, cp, 'MODEL_OUTPUT_INVALID', now);
      }

      const argsJson = canonicalJson(call.arguments);
      const target = entry.target(call.arguments);
      const auth = await this.authorizer.authorize({
        run,
        toolName: entry.name,
        effectClass: entry.effectClass,
        target,
        arguments: call.arguments,
      });
      if (auth.verdict === 'deny') {
        return this.parkNeedsAttention(run, fence, cp, 'POLICY_DENIED', now, 'blocked');
      }
      if (auth.verdict === 'ask') {
        // Approval UI is T22; in T13 an ask parks the run without dispatch.
        return this.parkNeedsAttention(run, fence, cp, 'WAITING_APPROVAL', now, 'blocked');
      }

      const fingerprint = computeFingerprint({
        toolName: entry.name,
        normalizedArgs: argsJson,
        target,
        inputVersions,
      });
      if (isLoopDetected(cp.fingerprints, fingerprint)) {
        // Fail closed on a runaway loop — NO dispatch (docs/07 §9).
        const r = await this.repo.terminateAgentRun({
          runId: run.id,
          workspaceId: run.workspaceId,
          expectedFence: fence,
          state: 'failed',
          outcome: 'partial',
          stopReason: 'LOOP_DETECTED',
          checkpoint: { ...cp, stopReason: 'LOOP_DETECTED' },
          now,
        });
        if (r === 'stale') return { runId: run.id, outcome: 'stale' };
        return { runId: run.id, outcome: 'failed', stopReason: 'LOOP_DETECTED' };
      }

      pending.push({
        id: logicalToolCallId(run.id, stepNo, call.index),
        providerToolIndex: call.index,
        stepNo,
        name: entry.name,
        argumentsJson: argsJson,
        argumentsSha256: sha256Hex(argsJson),
        effectClass: entry.effectClass,
        target,
        fingerprint,
        dispatched: false,
      });
    }

    const fingerprints: FingerprintRecord[] = [
      ...cp.fingerprints,
      ...pending.map((p) => ({ fingerprint: p.fingerprint, progressed: false })),
    ];
    const nextCp: AgentCheckpoint = {
      ...cp,
      phase: 'model_committed',
      stepNo,
      providerRequestId,
      pendingToolCalls: pending,
      fingerprints,
    };
    const committed = await this.repo.commitCheckpoint({
      runId: run.id,
      workspaceId: run.workspaceId,
      expectedFence: fence,
      checkpoint: nextCp,
      plan: planRes.plan,
      bumpPlanRevision: true,
      stepCount: stepNo,
      activeElapsedDeltaMs: this.activeMsPerStep,
      eventType: 'run.step_committed',
      eventPayload: { step_no: stepNo, pending_tool_call_ids: pending.map((p) => p.id) },
      now,
    });
    if (committed === 'stale') return { runId: run.id, outcome: 'stale' };
    return { runId: run.id, outcome: 'stepped' };
  }

  // ---------------------------------------------------------- dispatch phase

  private async dispatchStep(
    run: RunRecord,
    fence: string,
    cpInit: AgentCheckpoint,
    now: Date,
  ): Promise<AgentStepResult> {
    let cp = cpInit;
    const dispatchedNow: string[] = [];

    for (const p of cp.pendingToolCalls) {
      if (cp.toolResults[p.id]) continue; // already resolved — idempotent skip.

      if (p.dispatched) {
        // Intent committed but no result (crash mid-dispatch). Effect UNKNOWN; do NOT
        // replay it (docs/07 §5 retry matrix) — park for owner reconciliation.
        return this.parkNeedsAttention(run, fence, cp, 'TOOL_RESULT_UNKNOWN', now, 'blocked');
      }

      // 1) Commit dispatch INTENT before the seam call so a crash never re-dispatches.
      const marked = markDispatched(cp, p.id);
      const c1 = await this.repo.commitCheckpoint({
        runId: run.id,
        workspaceId: run.workspaceId,
        expectedFence: fence,
        checkpoint: marked,
        plan: [],
        bumpPlanRevision: false,
        stepCount: run.stepCount,
        activeElapsedDeltaMs: 0,
        eventType: 'tool.dispatching',
        eventPayload: { tool_call_id: p.id, tool_name: p.name },
        now,
      });
      if (c1 === 'stale') return { runId: run.id, outcome: 'stale' };
      cp = marked;

      // 2) Dispatch through the SEAM (mock transport here; T17 worker path later).
      let res: ToolResultRecord;
      try {
        res = await this.transport.dispatch({
          toolCallId: p.id,
          attemptId: toolAttemptId(p.id, 1),
          fencingToken: fence,
          toolName: p.name,
          arguments: JSON.parse(p.argumentsJson),
          effectClass: p.effectClass,
          target: p.target,
        });
      } catch (err) {
        if (err instanceof ToolDispatchUnavailableError) {
          // Production T13 seam: real dispatch is T17 — park at the gate, no effect.
          return this.parkNeedsAttention(run, fence, cp, 'WAITING_DISPATCH', now, 'partial');
        }
        throw err;
      }
      dispatchedNow.push(p.id);

      // 3) Record the result (CAS). Crash after this simply skips on resume.
      const withResult: AgentCheckpoint = {
        ...cp,
        toolResults: { ...cp.toolResults, [p.id]: res },
      };
      const c2 = await this.repo.commitCheckpoint({
        runId: run.id,
        workspaceId: run.workspaceId,
        expectedFence: fence,
        checkpoint: withResult,
        plan: [],
        bumpPlanRevision: false,
        stepCount: run.stepCount,
        activeElapsedDeltaMs: 0,
        eventType: 'tool.result',
        eventPayload: { tool_call_id: p.id, ok: res.ok },
        now,
      });
      if (c2 === 'stale') return { runId: run.id, outcome: 'stale' };
      cp = withResult;
    }

    // Settle: mark this step's fingerprints as progressed iff the result changed, clear
    // the pending list, and return to planning to feed the results back to the model.
    const settled = settleFingerprints(cp);
    const nextCp: AgentCheckpoint = {
      ...cp,
      phase: 'planning',
      pendingToolCalls: [],
      fingerprints: settled.fingerprints,
      lastResultShaByFingerprint: settled.lastResultShaByFingerprint,
    };
    const c = await this.repo.commitCheckpoint({
      runId: run.id,
      workspaceId: run.workspaceId,
      expectedFence: fence,
      checkpoint: nextCp,
      plan: [],
      bumpPlanRevision: false,
      stepCount: run.stepCount,
      activeElapsedDeltaMs: this.activeMsPerStep,
      eventType: 'run.tools_settled',
      eventPayload: { resolved: Object.keys(cp.toolResults).length },
      now,
    });
    if (c === 'stale') return { runId: run.id, outcome: 'stale' };
    return { runId: run.id, outcome: 'stepped', dispatched: dispatchedNow };
  }

  // ------------------------------------------------------------------ helpers

  private async finalize(
    run: RunRecord,
    fence: string,
    cp: AgentCheckpoint,
    result: GenerateResult,
    plan: unknown[],
    stepNo: number,
    now: Date,
  ): Promise<AgentStepResult> {
    const assistantMessageId = finalMessageId(run.id);
    const finalized = await this.repo.finalizeAgentRun({
      runId: run.id,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      chatId: run.chatId,
      expectedFence: fence,
      assistantMessageId,
      text: result.text,
      sha256: sha256Hex(result.text),
      providerLabel: result.providerLabel,
      isMock: result.isMock,
      usage: result.usage,
      finishReason: result.finishReason,
      checkpoint: { ...cp, phase: 'done', assistantMessageId, stopReason: null },
      plan,
      stepCount: stepNo,
      now,
    });
    if (finalized === 'stale') return { runId: run.id, outcome: 'stale' };
    return { runId: run.id, outcome: 'completed', assistantMessageId };
  }

  private async parkNeedsAttention(
    run: RunRecord,
    fence: string,
    cp: AgentCheckpoint,
    reason: AgentStopReason,
    now: Date,
    outcome: 'none' | 'partial' | 'blocked' = 'blocked',
  ): Promise<AgentStepResult> {
    const r = await this.repo.terminateAgentRun({
      runId: run.id,
      workspaceId: run.workspaceId,
      expectedFence: fence,
      state: 'needs_attention',
      outcome,
      stopReason: reason,
      checkpoint: { ...cp, stopReason: reason },
      now,
    });
    if (r === 'stale') return { runId: run.id, outcome: 'stale' };
    return { runId: run.id, outcome: 'needs_attention', stopReason: reason };
  }
}

// ---------------------------------------------------------------- pure helpers

function readCheckpoint(run: RunRecord): AgentCheckpoint {
  const raw = run.checkpoint ?? {};
  const phase = (raw['phase'] as StepPhase | undefined) ?? 'planning';
  return {
    phase,
    stepNo: typeof raw['step_no'] === 'number' ? (raw['step_no'] as number) : run.stepCount,
    agentSessionId: readStr(raw, 'agent_session_id') ?? '',
    objective: readStr(raw, 'objective') ?? readObjective(run),
    providerRequestId: readStr(raw, 'provider_request_id'),
    contextManifest: readManifest(raw['context_manifest']),
    pendingToolCalls: readPending(raw['pending_tool_calls']),
    toolResults: readResults(raw['tool_results']),
    fingerprints: readFingerprints(raw['fingerprints']),
    lastResultShaByFingerprint: readShaMap(raw['last_result_sha_by_fingerprint']),
    assistantMessageId: readStr(raw, 'assistant_message_id'),
    stopReason: readStr(raw, 'stop_reason'),
  };
}

function readStr(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function readManifest(v: unknown): AgentCheckpoint['contextManifest'] {
  if (typeof v !== 'object' || v === null) return { noteIds: [], artifactIds: [] };
  const o = v as Record<string, unknown>;
  return {
    noteIds: Array.isArray(o['noteIds']) ? o['noteIds'].filter(isString) : [],
    artifactIds: Array.isArray(o['artifactIds']) ? o['artifactIds'].filter(isString) : [],
  };
}

function readPending(v: unknown): PendingToolCall[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is PendingToolCall => typeof x === 'object' && x !== null);
}

function readResults(v: unknown): Record<string, ToolResultRecord> {
  if (typeof v !== 'object' || v === null) return {};
  return v as Record<string, ToolResultRecord>;
}

function readShaMap(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function readFingerprints(v: unknown): FingerprintRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is FingerprintRecord =>
      typeof x === 'object' &&
      x !== null &&
      typeof (x as Record<string, unknown>)['fingerprint'] === 'string',
  );
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function readObjective(run: RunRecord): string {
  const v = run.configSnapshot['objective'];
  return typeof v === 'string' ? v : '';
}

function readMaxSteps(run: RunRecord): number {
  const v = run.configSnapshot['max_steps'];
  return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_STEPS;
}

function readActiveElapsed(run: RunRecord): number {
  // The DB adapter surfaces active_elapsed_ms in the checkpoint mirror for the pure loop.
  const v = (run.checkpoint ?? {})['active_elapsed_ms'];
  return typeof v === 'number' && v >= 0 ? v : 0;
}

function readAttachedArtifactIds(snapshot: Record<string, unknown>): string[] {
  const v = snapshot['attached_artifact_ids'];
  return Array.isArray(v) ? v.filter(isString) : [];
}

function contextVersions(inputs: {
  selectedNotes: { id: string }[];
  attachedFiles: { id: string }[];
}): string[] {
  return [
    ...inputs.selectedNotes.map((n) => `note:${n.id}`),
    ...inputs.attachedFiles.map((f) => `file:${f.id}`),
  ];
}

function markDispatched(cp: AgentCheckpoint, toolCallId: string): AgentCheckpoint {
  return {
    ...cp,
    phase: 'model_committed',
    pendingToolCalls: cp.pendingToolCalls.map((p) =>
      p.id === toolCallId ? { ...p, dispatched: true } : p,
    ),
  };
}

/**
 * Mark THIS step's fingerprints (the trailing `pendingToolCalls.length` records) as
 * progressed iff each call's result sha changed vs the LAST result recorded for that
 * fingerprint (across steps). Identical repeated results = no progress, which is what
 * feeds loop detection. Returns the updated per-fingerprint sha map to persist.
 */
function settleFingerprints(cp: AgentCheckpoint): {
  fingerprints: FingerprintRecord[];
  lastResultShaByFingerprint: Record<string, string>;
} {
  const pending = cp.pendingToolCalls;
  const records = [...cp.fingerprints];
  const start = records.length - pending.length;
  const lastByFp: Record<string, string> = { ...cp.lastResultShaByFingerprint };

  for (let i = 0; i < pending.length; i += 1) {
    const p = pending[i]!;
    const sha = cp.toolResults[p.id]?.resultSha256 ?? '';
    const prev = Object.prototype.hasOwnProperty.call(lastByFp, p.fingerprint)
      ? lastByFp[p.fingerprint]
      : undefined;
    const progressed = prev === undefined ? true : sha !== prev;
    const idx = start + i;
    if (idx >= 0 && idx < records.length) {
      records[idx] = { fingerprint: p.fingerprint, progressed };
    }
    lastByFp[p.fingerprint] = sha;
  }
  return { fingerprints: records, lastResultShaByFingerprint: lastByFp };
}

/** Re-export the neutral message type consumers may need. */
export type { Message };

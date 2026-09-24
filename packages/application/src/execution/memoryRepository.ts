/**
 * In-memory {@link ExecutionRepository} for the scheduler's unit tests. It models the
 * atomic claim (capacity + project binding + `selected_worker_id`), the per-tool-call
 * fence (only the tool call's CURRENT attempt may write), and the result dedup /
 * conflict-quarantine semantics — the same rules the SQL adapter enforces with
 * `FOR UPDATE SKIP LOCKED` and the `(tool_call_id, fencing_token)` unique key.
 *
 * JavaScript is single-threaded, so `claimNextAttempt` runs to completion without an
 * interleaving await; the meaningful cross-connection concurrency guarantee is proven
 * against live PostgreSQL in `dbRepository.test.ts`.
 */
import { SessionSupersededError } from './errors.js';
import type {
  AckInput,
  AttemptRecord,
  ClaimContext,
  EnqueueAttemptInput,
  ExecutionRepository,
  FenceGuard,
  LiveRenewCheck,
  SubmitResultInput,
  SubmitResultOutcome,
  WorkerScope,
} from './ports.js';
import type { CanonicalValue } from './jcs.js';

const ACTIVE_ATTEMPT_STATES = new Set<AttemptRecord['state']>([
  'leased',
  'started',
  'uploading',
  'cancel_requested',
]);

interface WorkerSeed {
  workspaceId: string;
  capacity: number;
  sessionId: string;
  revoked: boolean;
}
interface RunSeed {
  workspaceId: string;
  projectId: string;
  selectedWorkerId: string | null;
  scopeVersionId: string | null;
  grantId: string | null;
  scopePolicySha256: string | null;
  policySnapshot: CanonicalValue | null;
}
interface GrantSeed {
  status: 'active' | 'revoked' | 'expired';
  policyEpoch: string;
}
interface ToolCallSeed {
  workspaceId: string;
  projectId: string;
  runId: string;
  toolName: string;
  toolInput: CanonicalValue;
  inputSha256: string;
  effectClass: string;
  timeoutSeconds: number | null;
  nextFence: number;
  currentAttemptId: string | null;
}

interface StoredAttempt extends AttemptRecord {
  resultJson: Record<string, unknown> | null;
  quarantined: boolean;
}

export interface ReconciliationNote {
  attemptId: string;
  reason: string;
  at: Date;
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly workspaces = new Map<string, string>(); // workspaceId → installationId
  private readonly workers = new Map<string, WorkerSeed>();
  private readonly bindings = new Set<string>(); // `${workerId}:${projectId}`
  private readonly runs = new Map<string, RunSeed>();
  private readonly grants = new Map<string, GrantSeed>();
  private readonly toolCalls = new Map<string, ToolCallSeed>();
  private readonly attempts = new Map<string, StoredAttempt>();
  private readonly inputArtifacts = new Set<string>(); // `${attemptId}:${artifactId}`
  public readonly reconciliations: ReconciliationNote[] = [];

  // ---- seeding helpers (tests only) ----
  seedWorkspace(workspaceId: string, installationId: string): void {
    this.workspaces.set(workspaceId, installationId);
  }
  seedWorker(workerId: string, seed: WorkerSeed): void {
    this.workers.set(workerId, seed);
  }
  setWorkerSession(workerId: string, sessionId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.sessionId = sessionId;
  }
  revokeWorker(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.revoked = true;
  }
  bindProject(workerId: string, projectId: string): void {
    this.bindings.add(`${workerId}:${projectId}`);
  }
  seedRun(runId: string, seed: RunSeed): void {
    this.runs.set(runId, seed);
  }
  seedGrant(grantId: string, seed: GrantSeed): void {
    this.grants.set(grantId, seed);
  }
  setGrant(grantId: string, patch: Partial<GrantSeed>): void {
    const g = this.grants.get(grantId);
    if (g) Object.assign(g, patch);
  }
  seedToolCall(
    toolCallId: string,
    seed: Omit<ToolCallSeed, 'nextFence' | 'currentAttemptId'>,
  ): void {
    this.toolCalls.set(toolCallId, { ...seed, nextFence: 0, currentAttemptId: null });
  }
  linkInputArtifact(attemptId: string, artifactId: string): void {
    this.inputArtifacts.add(`${attemptId}:${artifactId}`);
  }
  attempt(attemptId: string): AttemptRecord | undefined {
    return this.attempts.get(attemptId);
  }

  // ---- ExecutionRepository ----

  async enqueueAttempt(input: EnqueueAttemptInput, id: string): Promise<AttemptRecord> {
    const call = this.toolCalls.get(input.toolCallId);
    if (!call) throw new Error(`memory: unknown tool_call ${input.toolCallId}`);
    const priorMax = [...this.attempts.values()]
      .filter((a) => a.toolCallId === input.toolCallId)
      .reduce((m, a) => Math.max(m, a.attemptNo), 0);
    const attemptNo = priorMax + 1;
    if (attemptNo > 10) throw new Error('memory: attempt_no exceeds 10');
    call.nextFence += 1;
    const rec: StoredAttempt = {
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      attemptNo,
      fencingToken: String(call.nextFence),
      workerId: null,
      workerSessionId: null,
      state: 'queued',
      leaseUntil: null,
      leaseClaims: null,
      startedAt: null,
      finishedAt: null,
      resultSha256: null,
      effectObservation: null,
      journalSeq: '0',
      createdAt: new Date(Date.now() + this.attempts.size), // stable ordering
      resultJson: null,
      quarantined: false,
    };
    this.attempts.set(id, rec);
    call.currentAttemptId = id;
    return clone(rec);
  }

  async getAttempt(workspaceId: string, attemptId: string): Promise<AttemptRecord | null> {
    const a = this.attempts.get(attemptId);
    return a && a.workspaceId === workspaceId ? clone(a) : null;
  }

  async claimNextAttempt(
    scope: WorkerScope,
    sessionId: string,
    leaseUntil: Date,
  ): Promise<ClaimContext | null> {
    const worker = this.workers.get(scope.workerId);
    if (!worker || worker.workspaceId !== scope.workspaceId) throw new SessionSupersededError();
    if (worker.revoked || worker.sessionId !== sessionId) throw new SessionSupersededError();

    const active = [...this.attempts.values()].filter(
      (a) => a.workerId === scope.workerId && ACTIVE_ATTEMPT_STATES.has(a.state),
    ).length;
    if (active >= worker.capacity) return null;

    const candidates = [...this.attempts.values()]
      .filter((a) => a.state === 'queued' && a.workspaceId === scope.workspaceId)
      .filter((a) => this.bindings.has(`${scope.workerId}:${a.projectId}`))
      .filter((a) => {
        const run = this.runs.get(a.runId);
        return run && (run.selectedWorkerId === null || run.selectedWorkerId === scope.workerId);
      })
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : 1));

    const attempt = candidates[0];
    if (!attempt) return null;

    attempt.state = 'leased';
    attempt.workerId = scope.workerId;
    attempt.workerSessionId = sessionId;
    attempt.leaseUntil = leaseUntil;

    return this.buildClaimContext(attempt, sessionId);
  }

  private buildClaimContext(attempt: StoredAttempt, sessionId: string): ClaimContext {
    const call = this.toolCalls.get(attempt.toolCallId)!;
    const run = this.runs.get(attempt.runId)!;
    const grant = run.grantId ? this.grants.get(run.grantId) : undefined;
    return {
      attempt: clone(attempt),
      installationId:
        this.workspaces.get(attempt.workspaceId) ?? '00000000-0000-4000-8000-000000000000',
      workerSessionId: sessionId,
      toolName: call.toolName,
      toolInput: call.toolInput,
      inputSha256: call.inputSha256,
      effectClass: call.effectClass,
      timeoutSeconds: call.timeoutSeconds,
      scopeVersionId: run.scopeVersionId,
      grantId: run.grantId,
      policyEpoch: grant?.policyEpoch ?? '1',
      scopePolicySha256: run.scopePolicySha256,
      inputArtifactIds: [...this.inputArtifacts]
        .filter((k) => k.startsWith(`${attempt.id}:`))
        .map((k) => k.slice(attempt.id.length + 1)),
      policySnapshot: run.policySnapshot,
    };
  }

  async recordLease(
    workspaceId: string,
    attemptId: string,
    _fencingToken: string,
    leaseClaims: Record<string, unknown>,
  ): Promise<void> {
    const a = this.attempts.get(attemptId);
    if (a && a.workspaceId === workspaceId) a.leaseClaims = leaseClaims;
  }

  async getLiveRenewCheck(workspaceId: string, attemptId: string): Promise<LiveRenewCheck | null> {
    const a = this.attempts.get(attemptId);
    if (!a || a.workspaceId !== workspaceId || !a.workerId) return null;
    const worker = this.workers.get(a.workerId);
    if (!worker) return null;
    const grantId = (a.leaseClaims?.['grant_id'] as string | null | undefined) ?? null;
    const grant = grantId ? this.grants.get(grantId) : undefined;
    return {
      workerSessionId: worker.sessionId,
      workerRevoked: worker.revoked,
      grantStatus: grant ? grant.status : null,
      grantPolicyEpoch: grant ? grant.policyEpoch : null,
    };
  }

  async applyAck(
    scope: WorkerScope,
    attemptId: string,
    input: AckInput,
    now: Date,
  ): Promise<FenceGuard> {
    const guard = this.fence(scope, attemptId, input.sessionId, input.fencingToken);
    if (guard.kind !== 'ok') return guard;
    const a = this.attempts.get(attemptId)!;
    if (input.phase === 'started') {
      if (a.state === 'leased' || a.state === 'started') {
        a.state = 'started';
        if (!a.startedAt) a.startedAt = now;
      }
    }
    // phase 'accepted' keeps the attempt leased (an ACK is not an actual start).
    a.journalSeq = maxCounter(a.journalSeq, input.journalSeq);
    return { kind: 'ok', attempt: clone(a) };
  }

  async extendLease(
    scope: WorkerScope,
    attemptId: string,
    fencingToken: string,
    leaseUntil: Date,
  ): Promise<FenceGuard> {
    const guard = this.fence(scope, attemptId, undefined, fencingToken);
    if (guard.kind !== 'ok') return guard;
    const a = this.attempts.get(attemptId)!;
    a.leaseUntil = leaseUntil;
    return { kind: 'ok', attempt: clone(a) };
  }

  async submitResult(
    scope: WorkerScope,
    attemptId: string,
    input: SubmitResultInput,
    now: Date,
  ): Promise<SubmitResultOutcome> {
    const guard = this.fence(scope, attemptId, input.sessionId, input.fencingToken);
    if (guard.kind === 'not-found') return { kind: 'not-found' };
    if (guard.kind === 'session-superseded') return { kind: 'session-superseded' };
    if (guard.kind === 'stale-fence') {
      this.reconciliations.push({ attemptId, reason: 'stale_fence_result', at: now });
      return { kind: 'stale-fence', currentFence: guard.currentFence };
    }
    const a = this.attempts.get(attemptId)!;
    if (a.resultSha256) {
      if (a.resultSha256 === input.resultSha256) {
        return { kind: 'duplicate', attempt: clone(a) };
      }
      a.quarantined = true;
      this.reconciliations.push({ attemptId, reason: 'result_conflict', at: now });
      return { kind: 'conflict-quarantined', attempt: clone(a) };
    }
    a.state = input.status;
    a.resultSha256 = input.resultSha256;
    a.effectObservation = input.effectObservation;
    a.finishedAt = input.finishedAt;
    a.startedAt = a.startedAt ?? input.startedAt;
    a.resultJson = input.resultJson;
    return { kind: 'accepted', attempt: clone(a) };
  }

  async authorizeInputArtifact(
    scope: WorkerScope,
    attemptId: string,
    sessionId: string,
    fencingToken: string,
    artifactId: string,
  ): Promise<'ok' | 'not-found' | 'session-superseded' | 'stale-fence' | 'artifact-not-linked'> {
    const guard = this.fence(scope, attemptId, sessionId, fencingToken);
    if (guard.kind === 'not-found') return 'not-found';
    if (guard.kind === 'session-superseded') return 'session-superseded';
    if (guard.kind === 'stale-fence') return 'stale-fence';
    return this.inputArtifacts.has(`${attemptId}:${artifactId}`) ? 'ok' : 'artifact-not-linked';
  }

  async reattemptAfterReconcile(
    workspaceId: string,
    priorAttemptId: string,
    newAttemptId: string,
    reason: string,
  ): Promise<AttemptRecord> {
    const prior = this.attempts.get(priorAttemptId);
    if (!prior || prior.workspaceId !== workspaceId)
      throw new Error('memory: prior attempt not found');
    // Settle the prior attempt terminally (canceled) before minting a fresh one — a
    // lost op is never silently re-run; reconciliation owns this transition.
    prior.state = 'canceled';
    prior.finishedAt = prior.finishedAt ?? new Date();
    this.reconciliations.push({ attemptId: priorAttemptId, reason, at: new Date() });
    return this.enqueueAttempt(
      {
        workspaceId: prior.workspaceId,
        projectId: prior.projectId,
        runId: prior.runId,
        toolCallId: prior.toolCallId,
      },
      newAttemptId,
    );
  }

  /**
   * The per-tool-call fence guard: a write is accepted only for the tool call's CURRENT
   * attempt with the matching fencing token; a superseded attempt's write is stale.
   */
  private fence(
    scope: WorkerScope,
    attemptId: string,
    sessionId: string | undefined,
    fencingToken: string,
  ): FenceGuard {
    const a = this.attempts.get(attemptId);
    if (!a || a.workspaceId !== scope.workspaceId || a.workerId !== scope.workerId) {
      return { kind: 'not-found' };
    }
    if (sessionId !== undefined && a.workerSessionId !== sessionId) {
      return { kind: 'session-superseded' };
    }
    const call = this.toolCalls.get(a.toolCallId)!;
    const currentFence = call.currentAttemptId
      ? (this.attempts.get(call.currentAttemptId)?.fencingToken ?? a.fencingToken)
      : a.fencingToken;
    if (call.currentAttemptId !== attemptId || a.fencingToken !== fencingToken) {
      return { kind: 'stale-fence', currentFence };
    }
    return { kind: 'ok', attempt: clone(a) };
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function maxCounter(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

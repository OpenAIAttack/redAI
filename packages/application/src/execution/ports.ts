/**
 * Ports for the task-scheduler / signed-lease / result plane (T17).
 *
 * The scheduler turns a queued {@link AttemptRecord} into a signed lease for exactly
 * one worker, then accepts ACK/renew/result writes fenced by `(worker_session_id,
 * fencing_token)`. Records are DB-neutral (camelCase); no `pg`/`@redai/db` type leaks
 * here, so the service's unit tests drive the in-memory fake with a deterministic
 * clock and scripted ids. Every read/write is scoped by `workspaceId` (and, for
 * project-level rows, `projectId`) — INV-001.
 *
 * Security posture baked into these shapes (docs/08 §§4–9, AGENTS.md):
 *   - a lease is a short-lived right for ONE attempt, never an owner credential;
 *   - the fence guards SERVER writes only — it is never a claim of exactly-once
 *     external effect, and a lost external op is never auto-reassigned;
 *   - `effect_observation` is `not_started | completed | unknown`; an unproven
 *     outcome settles `unknown`, it is never reported as success.
 */
import type { CanonicalValue } from './jcs.js';

export interface Clock {
  now(): Date;
}

/** Fresh identifiers for new attempts (UUID). */
export interface IdSource {
  uuid(): string;
}

export type AttemptState =
  | 'queued'
  | 'leased'
  | 'started'
  | 'uploading'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'canceled'
  | 'lost'
  | 'unknown';

export type EffectObservation = 'not_started' | 'completed' | 'unknown';
export type WorkerResultStatus = 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type NetworkProfile = 'offline' | 'scoped_web';

/** The scope identity that must accompany the request (bearer-verified upstream). */
export interface WorkerScope {
  workspaceId: string;
  workerId: string;
}

export interface AttemptRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  toolCallId: string;
  attemptNo: number;
  fencingToken: string;
  workerId: string | null;
  workerSessionId: string | null;
  state: AttemptState;
  leaseUntil: Date | null;
  leaseClaims: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  resultSha256: string | null;
  effectObservation: EffectObservation | null;
  journalSeq: string;
  createdAt: Date;
}

/** What a queued attempt needs to exist (created by the runtime dispatch seam). */
export interface EnqueueAttemptInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  toolCallId: string;
  /** Optional explicit id; otherwise the repo mints one. */
  attemptId?: string;
}

/**
 * The DB-derived facts the service needs to build the signed lease claims for a
 * freshly-leased attempt. The repo has already flipped the attempt to `leased` inside
 * its claim transaction; the service folds in its non-secret config (image/manifest
 * digests, resource limits), mints the JWS and calls {@link ExecutionRepository.recordLease}.
 */
export interface ClaimContext {
  attempt: AttemptRecord;
  installationId: string;
  workerSessionId: string;
  toolName: string;
  toolInput: CanonicalValue;
  inputSha256: string;
  /** Registry-classified effect (server-owned), used to derive the network profile. */
  effectClass: string;
  /** Tool-call timeout override, or null for the service default. */
  timeoutSeconds: number | null;
  scopeVersionId: string | null;
  grantId: string | null;
  policyEpoch: string;
  scopePolicySha256: string | null;
  inputArtifactIds: string[];
  policySnapshot: CanonicalValue | null;
}

export interface ResourceLimits {
  cpu_millis: number;
  memory_bytes: number;
  pids: number;
  output_bytes: number;
}

/** The live-authorization snapshot renewal re-reads (docs/08 §4, docs/10 §7). */
export interface LiveRenewCheck {
  workerSessionId: string;
  workerRevoked: boolean;
  /** null when the attempt has no grant (offline). */
  grantStatus: 'active' | 'revoked' | 'expired' | null;
  grantPolicyEpoch: string | null;
}

export type AckPhase = 'accepted' | 'started';

export interface AckInput {
  sessionId: string;
  fencingToken: string;
  phase: AckPhase;
  journalSeq: string;
  containerRef: string | null;
}

export interface RenewInput {
  sessionId: string;
  fencingToken: string;
  journalSeq: string;
  observedState: AttemptState;
}

export interface SubmitResultInput {
  sessionId: string;
  fencingToken: string;
  status: WorkerResultStatus;
  startedAt: Date | null;
  finishedAt: Date;
  exitCode: number | null;
  summary: string;
  artifactIds: string[];
  structuredResult: Record<string, unknown>;
  outputTruncated: boolean;
  observedQuiescent: boolean;
  effectObservation: EffectObservation;
  resultSha256: string;
  /** The full result document (for durable audit); stored as `result_json`. */
  resultJson: Record<string, unknown>;
}

/** Fence-write guard outcomes shared by ACK/renew/result. */
export type FenceGuard =
  | { kind: 'ok'; attempt: AttemptRecord }
  | { kind: 'not-found' }
  | { kind: 'session-superseded' }
  | { kind: 'stale-fence'; currentFence: string };

/**
 * The DB (or in-memory) substrate for the scheduler. Claim + result mutations are
 * atomic and fenced; the SQL adapter runs them inside a single transaction with
 * `FOR UPDATE SKIP LOCKED` so a concurrent claim gives the attempt to exactly one
 * worker and never oversubscribes `worker_capacity`.
 */
export interface ExecutionRepository {
  /** Create a queued attempt (attempt_no = prior max + 1, fresh fencing token). */
  enqueueAttempt(input: EnqueueAttemptInput, id: string): Promise<AttemptRecord>;

  getAttempt(workspaceId: string, attemptId: string): Promise<AttemptRecord | null>;

  /**
   * Atomically claim the oldest queued attempt bound to `workerId` (project binding +
   * `selected_worker_id`), honouring `capacity`. Returns null when nothing is
   * claimable OR the worker has no free slot. Throws {@link SessionSupersededError}
   * when `sessionId` is not the worker's active session.
   */
  claimNextAttempt(
    scope: WorkerScope,
    sessionId: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<ClaimContext | null>;

  /** Persist the minted lease claims JSON for a just-leased attempt. */
  recordLease(
    workspaceId: string,
    attemptId: string,
    fencingToken: string,
    leaseClaims: Record<string, unknown>,
  ): Promise<void>;

  /** The live authorization snapshot renewal re-reads. */
  getLiveRenewCheck(workspaceId: string, attemptId: string): Promise<LiveRenewCheck | null>;

  /**
   * Fence-guarded state transition for an ACK phase. Idempotent: re-ACKing the same
   * phase with the same fence returns `{ kind: 'ok' }` without a second write.
   */
  applyAck(scope: WorkerScope, attemptId: string, input: AckInput, now: Date): Promise<FenceGuard>;

  /** Extend the lease (fence-guarded). Caller has already passed the live checks. */
  extendLease(
    scope: WorkerScope,
    attemptId: string,
    fencingToken: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<FenceGuard>;

  /**
   * Fence-guarded result write with dedup/conflict semantics (docs/08 §9):
   *   - same fence + same `result_sha256` → idempotent duplicate;
   *   - same fence + different digest → RESULT_CONFLICT, attempt quarantined;
   *   - stale fence → recorded as a safe reconciliation note, never accepted.
   */
  submitResult(
    scope: WorkerScope,
    attemptId: string,
    input: SubmitResultInput,
    now: Date,
  ): Promise<SubmitResultOutcome>;

  /** Verify an input artifact is linked to this attempt and the fence/session match. */
  authorizeInputArtifact(
    scope: WorkerScope,
    attemptId: string,
    sessionId: string,
    fencingToken: string,
    artifactId: string,
  ): Promise<'ok' | 'not-found' | 'session-superseded' | 'stale-fence' | 'artifact-not-linked'>;

  /**
   * Explicit, reconciliation-gated re-attempt: mark the prior attempt `lost` and mint
   * a NEW attempt (attempt_no + 1, fresh fence). Never called automatically after a
   * mere lease expiry — a lost external op is only re-attempted on explicit owner /
   * reconcile decision (docs/08 §6, INV: unsafe_effect_replay never_without_reconciliation).
   */
  reattemptAfterReconcile(
    workspaceId: string,
    priorAttemptId: string,
    newAttemptId: string,
    reason: string,
  ): Promise<AttemptRecord>;
}

export interface SubmitResultOutcome {
  kind:
    | 'accepted'
    | 'duplicate'
    | 'conflict-quarantined'
    | 'stale-fence'
    | 'not-found'
    | 'session-superseded';
  attempt?: AttemptRecord;
  currentFence?: string;
}

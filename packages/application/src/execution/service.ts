/**
 * Task scheduler, signed-lease and result use cases (T17).
 *
 * The service turns a queued attempt into an Ed25519-signed lease for exactly one
 * worker, then accepts fenced ACK/renew/result writes. It is pure orchestration over
 * injected collaborators (repository, {@link LeaseSigner}, clock, id source) — it opens
 * no sockets and reads no globals, so unit tests drive it with the in-memory fake.
 *
 * Security invariants enforced here (docs/08, AGENTS.md):
 *   - the fence guards SERVER writes only; accepting a result is NEVER a claim of
 *     exactly-once external effect, and a lost external op is never auto-reassigned;
 *   - renewal re-reads the LIVE worker session + grant + policy epoch and refuses when
 *     any changed or the lease already expired — a stale snapshot cannot keep a task
 *     alive past a revoke;
 *   - a conflicting result digest quarantines the attempt rather than overwriting;
 *   - an unproven outcome settles `unknown`, never reported success.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalize, mintLeaseJws, type CanonicalValue, type LeaseSigner } from './jcs.js';
import {
  ArtifactNotLinkedError,
  AttemptNotFoundError,
  CapabilityInvalidError,
  ResultConflictError,
  SessionSupersededError,
  StaleFenceError,
} from './errors.js';
import type {
  AckInput,
  AttemptRecord,
  Clock,
  EnqueueAttemptInput,
  ExecutionRepository,
  IdSource,
  NetworkProfile,
  ResourceLimits,
  SubmitResultInput,
  WorkerScope,
} from './ports.js';

// SPEC_LOCK worker cadences.
export const WORKER_LEASE_SECONDS = 45;
export const WORKER_RENEW_SECONDS = 10;
export const WORKER_SAFETY_MARGIN_SECONDS = 5;
/** Credential capability TTL ceiling (docs/08 §11): ≤30s and never longer than the lease. */
export const CAPABILITY_MAX_TTL_SECONDS = 30;
/** SPEC_LOCK tool_timeout_seconds default. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

const LEASE_CLAIMS_SCHEMA_VERSION = '1.0';

/** Non-secret defaults folded into every minted lease (mock/stub executor: T18). */
export interface ExecutionServiceConfig {
  /** Toolbox image digest pinned into the lease (`sha256:<64hex>`). */
  imageDigest: string;
  /** Toolbox manifest digest (`tool_manifest_sha256`). */
  toolManifestSha256: string;
  leaseSeconds?: number;
  resourceLimits?: ResourceLimits;
}

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  cpu_millis: 1000,
  memory_bytes: 536870912, // 512 MiB
  pids: 128,
  output_bytes: 26214400,
};

/**
 * Resolves a credential capability to the plaintext fields a trusted adapter needs.
 * Plaintext lives only in the resolver's/adapter's memory, never in the task envelope,
 * prompt, log or shared sandbox env (docs/08 §11). Injected by the coordinator; absent
 * in tests that don't exercise capability resolution.
 */
export interface CredentialResolver {
  resolve(input: { workspaceId: string; credentialRef: string; originRuleId: string }): Promise<{
    kind: 'http_headers' | 'browser_form';
    allowedOrigin: string;
    fields: Record<string, string>;
  } | null>;
}

export interface ExecutionServiceDeps {
  repo: ExecutionRepository;
  signer: LeaseSigner;
  config: ExecutionServiceConfig;
  clock?: Clock;
  ids?: IdSource;
  /** HMAC key for capability tokens (per-installation secret). */
  capabilitySecret?: Buffer;
  credentialResolver?: CredentialResolver;
}

export interface TaskEnvelope {
  claims: Record<string, unknown>;
  lease_jws: string;
  input: Record<string, unknown>;
  policy_snapshot: Record<string, unknown> | null;
  input_artifact_ids: string[];
}

export type RenewResult =
  | { ok: true; directive: 'continue'; leaseJws: string; expiresAt: Date }
  | { ok: false; directive: 'cancel' | 'reconcile'; reason: string };

export interface ResultAck {
  accepted: boolean;
  duplicate: boolean;
  authoritative: boolean;
}

const systemClock: Clock = { now: () => new Date() };

export class ExecutionService {
  private readonly repo: ExecutionRepository;
  private readonly signer: LeaseSigner;
  private readonly cfg: ExecutionServiceConfig;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly capabilitySecret: Buffer | null;
  private readonly credentialResolver: CredentialResolver | null;
  private readonly leaseSeconds: number;
  private readonly resourceLimits: ResourceLimits;

  public constructor(deps: ExecutionServiceDeps) {
    this.repo = deps.repo;
    this.signer = deps.signer;
    this.cfg = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.ids ?? { uuid: () => cryptoRandomUuid() };
    this.capabilitySecret = deps.capabilitySecret ?? null;
    this.credentialResolver = deps.credentialResolver ?? null;
    this.leaseSeconds = deps.config.leaseSeconds ?? WORKER_LEASE_SECONDS;
    this.resourceLimits = deps.config.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  }

  /** Enqueue a queued attempt for a tool call (the runtime dispatch seam calls this). */
  async enqueueAttempt(input: EnqueueAttemptInput): Promise<AttemptRecord> {
    return this.repo.enqueueAttempt(input, input.attemptId ?? this.ids.uuid());
  }

  /**
   * Claim the next queued attempt for `scope.workerId` in `sessionId`. Returns the
   * signed task envelope, or null when nothing is claimable / no free slot. Exactly
   * one concurrent caller wins a given attempt (repo `FOR UPDATE SKIP LOCKED`).
   */
  async claim(scope: WorkerScope, sessionId: string): Promise<TaskEnvelope | null> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1000);
    const ctx = await this.repo.claimNextAttempt(scope, sessionId, leaseUntil, now);
    if (!ctx) return null;

    // The network profile is derived from the SERVER-classified effect class plus the
    // presence of a live grant + inlined policy snapshot — never trusted from the model
    // (AGENTS.md). Without all three, the task runs offline.
    const wantsWeb =
      ctx.effectClass === 'external_read' ||
      ctx.effectClass === 'external_write' ||
      ctx.effectClass === 'destructive';
    const networkProfile: NetworkProfile =
      wantsWeb && ctx.grantId && ctx.scopeVersionId && ctx.scopePolicySha256 && ctx.policySnapshot
        ? 'scoped_web'
        : 'offline';
    const timeoutSeconds = ctx.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

    const claims: Record<string, unknown> = {
      schema_version: LEASE_CLAIMS_SCHEMA_VERSION,
      installation_id: ctx.installationId,
      workspace_id: ctx.attempt.workspaceId,
      project_id: ctx.attempt.projectId,
      run_id: ctx.attempt.runId,
      tool_call_id: ctx.attempt.toolCallId,
      attempt_id: ctx.attempt.id,
      attempt_no: ctx.attempt.attemptNo,
      fencing_token: ctx.attempt.fencingToken,
      worker_id: scope.workerId,
      worker_session_id: ctx.workerSessionId,
      tool_name: ctx.toolName,
      input_sha256: ctx.inputSha256,
      scope_version_id: networkProfile === 'scoped_web' ? ctx.scopeVersionId : null,
      grant_id: networkProfile === 'scoped_web' ? ctx.grantId : null,
      policy_epoch: ctx.policyEpoch,
      image_digest: this.cfg.imageDigest,
      network_profile: networkProfile,
      timeout_seconds: timeoutSeconds,
      issued_at: now.toISOString(),
      expires_at: leaseUntil.toISOString(),
      scope_policy_sha256: networkProfile === 'scoped_web' ? ctx.scopePolicySha256 : null,
      tool_manifest_sha256: this.cfg.toolManifestSha256,
      resource_limits: this.resourceLimits,
    };

    const leaseJws = mintLeaseJws(claims as CanonicalValue, this.signer);
    await this.repo.recordLease(
      ctx.attempt.workspaceId,
      ctx.attempt.id,
      ctx.attempt.fencingToken,
      claims,
    );

    return {
      claims,
      lease_jws: leaseJws,
      input: ctx.toolInput as Record<string, unknown>,
      policy_snapshot:
        networkProfile === 'scoped_web'
          ? ((ctx.policySnapshot as Record<string, unknown> | null) ?? null)
          : null,
      input_artifact_ids: ctx.inputArtifactIds,
    };
  }

  /**
   * ACK a phase for an attempt. `accepted` records the worker took the task (server
   * keeps it `leased` — an ACK is not an actual start); `started` records the real
   * container start. Idempotent for a repeated same-phase ACK on the same fence.
   */
  async ack(
    scope: WorkerScope,
    attemptId: string,
    input: AckInput,
  ): Promise<{ state: AttemptRecord['state'] }> {
    const guard = await this.repo.applyAck(scope, attemptId, input, this.clock.now());
    switch (guard.kind) {
      case 'ok':
        return { state: guard.attempt.state };
      case 'not-found':
        throw new AttemptNotFoundError();
      case 'session-superseded':
        throw new SessionSupersededError();
      case 'stale-fence':
        throw new StaleFenceError(guard.currentFence);
    }
  }

  /**
   * Re-check the LIVE grant + policy epoch + worker session, then extend the lease.
   * Refuses (never issues a fresh lease) on a superseded session, a revoked/expired
   * grant, a bumped policy epoch, or an already-expired lease (docs/08 §4).
   */
  async renew(
    scope: WorkerScope,
    attemptId: string,
    input: {
      sessionId: string;
      fencingToken: string;
      journalSeq: string;
      observedState: AttemptRecord['state'];
    },
  ): Promise<RenewResult> {
    const now = this.clock.now();
    const attempt = await this.repo.getAttempt(scope.workspaceId, attemptId);
    if (!attempt) throw new AttemptNotFoundError();

    // A settled attempt cannot be renewed.
    if (!isLiveState(attempt.state)) {
      return { ok: false, directive: 'reconcile', reason: 'attempt_not_live' };
    }
    // Stale fence: the write belongs to a superseded attempt of the same call.
    if (input.fencingToken !== attempt.fencingToken) {
      return { ok: false, directive: 'cancel', reason: 'stale_fence' };
    }
    // Lease already lapsed: refuse; do NOT mark canceled purely on elapsed time
    // (docs/08 §7) — the worker/watchdog stops and reconciliation decides.
    if (attempt.leaseUntil && attempt.leaseUntil.getTime() <= now.getTime()) {
      return { ok: false, directive: 'reconcile', reason: 'lease_expired' };
    }

    const live = await this.repo.getLiveRenewCheck(scope.workspaceId, attemptId);
    if (!live) throw new AttemptNotFoundError();
    if (live.workerRevoked) return { ok: false, directive: 'cancel', reason: 'worker_revoked' };
    if (
      input.sessionId !== live.workerSessionId ||
      attempt.workerSessionId !== live.workerSessionId
    ) {
      return { ok: false, directive: 'cancel', reason: 'session_superseded' };
    }

    // Grant re-check for scoped tasks. The leased epoch is captured in lease_claims.
    const leasedGrantId = (attempt.leaseClaims?.['grant_id'] as string | null | undefined) ?? null;
    if (leasedGrantId) {
      if (live.grantStatus !== 'active') {
        return { ok: false, directive: 'cancel', reason: 'grant_not_active' };
      }
      const leasedEpoch = (attempt.leaseClaims?.['policy_epoch'] as string | undefined) ?? null;
      if (leasedEpoch !== null && live.grantPolicyEpoch !== leasedEpoch) {
        return { ok: false, directive: 'cancel', reason: 'policy_epoch_stale' };
      }
    }

    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1000);
    const guard = await this.repo.extendLease(
      scope,
      attemptId,
      input.fencingToken,
      leaseUntil,
      now,
    );
    if (guard.kind !== 'ok') {
      return {
        ok: false,
        directive: 'cancel',
        reason: guard.kind === 'session-superseded' ? 'session_superseded' : 'stale_fence',
      };
    }

    // Re-mint the lease with the same claims but refreshed issued_at/expires_at.
    const claims = { ...(attempt.leaseClaims ?? {}) } as Record<string, unknown>;
    claims['issued_at'] = now.toISOString();
    claims['expires_at'] = leaseUntil.toISOString();
    const leaseJws = mintLeaseJws(claims as CanonicalValue, this.signer);
    return { ok: true, directive: 'continue', leaseJws, expiresAt: leaseUntil };
  }

  /**
   * Submit a terminal result. Dedup + conflict semantics (docs/08 §9): a repeat with
   * the same digest is an idempotent duplicate ACK; a different digest quarantines the
   * attempt (RESULT_CONFLICT); a stale fence is recorded for safe reconciliation and
   * NOT accepted as success.
   */
  async submitResult(
    scope: WorkerScope,
    attemptId: string,
    input: SubmitResultInput,
  ): Promise<ResultAck> {
    const outcome = await this.repo.submitResult(scope, attemptId, input, this.clock.now());
    switch (outcome.kind) {
      case 'accepted':
        return { accepted: true, duplicate: false, authoritative: true };
      case 'duplicate':
        return { accepted: true, duplicate: true, authoritative: true };
      case 'conflict-quarantined':
        throw new ResultConflictError();
      case 'stale-fence':
        // Not accepted as a result; a safe reconciliation record was kept.
        throw new StaleFenceError(outcome.currentFence ?? '0');
      case 'session-superseded':
        throw new SessionSupersededError();
      case 'not-found':
        throw new AttemptNotFoundError();
    }
  }

  /** Authorize (and thereby gate) an attempt-bound input-artifact download. */
  async authorizeInputArtifact(
    scope: WorkerScope,
    attemptId: string,
    sessionId: string,
    fencingToken: string,
    artifactId: string,
  ): Promise<void> {
    const res = await this.repo.authorizeInputArtifact(
      scope,
      attemptId,
      sessionId,
      fencingToken,
      artifactId,
    );
    switch (res) {
      case 'ok':
        return;
      case 'not-found':
        throw new AttemptNotFoundError();
      case 'session-superseded':
        throw new SessionSupersededError();
      case 'stale-fence':
        throw new StaleFenceError('0');
      case 'artifact-not-linked':
        throw new ArtifactNotLinkedError();
    }
  }

  // ---------------------------------------------------------- credential capability

  /**
   * Issue a short-lived credential capability bound to (attempt, session, fence,
   * credential_ref, origin). The capability is an HMAC token, NOT the secret itself;
   * the plaintext is only revealed later via {@link resolveCapability} to a trusted
   * adapter. TTL is ≤30s and never longer than the remaining lease (docs/08 §11).
   */
  async issueCapability(
    scope: WorkerScope,
    attemptId: string,
    input: { sessionId: string; fencingToken: string; credentialRef: string; originRuleId: string },
  ): Promise<{ capabilityToken: string; expiresAt: Date; allowedOrigin: string }> {
    if (!this.capabilitySecret)
      throw new CapabilityInvalidError('Capabilities are not configured.');
    const attempt = await this.repo.getAttempt(scope.workspaceId, attemptId);
    if (!attempt) throw new AttemptNotFoundError();
    if (attempt.workerSessionId !== input.sessionId) throw new SessionSupersededError();
    if (attempt.fencingToken !== input.fencingToken)
      throw new StaleFenceError(attempt.fencingToken);
    if (!isLiveState(attempt.state)) throw new AttemptNotFoundError();
    const now = this.clock.now();
    // Never longer than the lease and never issued when the lease is about to expire.
    const leaseRemainingMs = attempt.leaseUntil ? attempt.leaseUntil.getTime() - now.getTime() : 0;
    if (leaseRemainingMs <= WORKER_SAFETY_MARGIN_SECONDS * 1000) {
      throw new CapabilityInvalidError('Lease is too close to expiry for a capability.');
    }
    const ttlMs = Math.min(CAPABILITY_MAX_TTL_SECONDS * 1000, leaseRemainingMs);
    const expiresAt = new Date(now.getTime() + ttlMs);
    const resolved = this.credentialResolver
      ? await this.credentialResolver.resolve({
          workspaceId: scope.workspaceId,
          credentialRef: input.credentialRef,
          originRuleId: input.originRuleId,
        })
      : null;
    if (!resolved)
      throw new CapabilityInvalidError('Credential is not resolvable for this origin.');

    const payload = {
      workspace_id: scope.workspaceId,
      worker_id: scope.workerId,
      attempt_id: attemptId,
      session_id: input.sessionId,
      fencing_token: input.fencingToken,
      credential_ref: input.credentialRef,
      origin_rule_id: input.originRuleId,
      exp: expiresAt.toISOString(),
    };
    const token = this.signCapability(payload);
    return { capabilityToken: token, expiresAt, allowedOrigin: resolved.allowedOrigin };
  }

  /**
   * Resolve a capability to plaintext fields for a trusted adapter. Re-verifies the
   * HMAC, the TTL and the attempt/session/fence binding against the LIVE attempt.
   */
  async resolveCapability(
    scope: WorkerScope,
    attemptId: string,
    input: { sessionId: string; fencingToken: string; capabilityToken: string },
  ): Promise<{
    kind: 'http_headers' | 'browser_form';
    allowedOrigin: string;
    fields: Record<string, string>;
    expiresAt: Date;
  }> {
    if (!this.capabilitySecret)
      throw new CapabilityInvalidError('Capabilities are not configured.');
    const payload = this.verifyCapability(input.capabilityToken);
    const now = this.clock.now();
    if (
      payload['workspace_id'] !== scope.workspaceId ||
      payload['worker_id'] !== scope.workerId ||
      payload['attempt_id'] !== attemptId ||
      payload['session_id'] !== input.sessionId ||
      payload['fencing_token'] !== input.fencingToken
    ) {
      throw new CapabilityInvalidError('Capability binding mismatch.');
    }
    const exp = new Date(String(payload['exp']));
    if (!(exp.getTime() > now.getTime())) throw new CapabilityInvalidError('Capability expired.');

    const attempt = await this.repo.getAttempt(scope.workspaceId, attemptId);
    if (
      !attempt ||
      attempt.workerSessionId !== input.sessionId ||
      attempt.fencingToken !== input.fencingToken
    ) {
      throw new SessionSupersededError();
    }
    if (!this.credentialResolver)
      throw new CapabilityInvalidError('No credential resolver configured.');
    const resolved = await this.credentialResolver.resolve({
      workspaceId: scope.workspaceId,
      credentialRef: String(payload['credential_ref']),
      originRuleId: String(payload['origin_rule_id']),
    });
    if (!resolved)
      throw new CapabilityInvalidError('Credential is not resolvable for this origin.');
    return {
      kind: resolved.kind,
      allowedOrigin: resolved.allowedOrigin,
      fields: resolved.fields,
      expiresAt: exp,
    };
  }

  private signCapability(payload: Record<string, unknown>): string {
    const body = Buffer.from(canonicalize(payload as CanonicalValue), 'utf8');
    const mac = createHmac('sha256', this.capabilitySecret!).update(body).digest();
    return `${body.toString('base64url')}.${mac.toString('base64url')}`;
  }

  private verifyCapability(token: string): Record<string, unknown> {
    const dot = token.indexOf('.');
    if (dot <= 0) throw new CapabilityInvalidError();
    const bodyB64 = token.slice(0, dot);
    const macB64 = token.slice(dot + 1);
    let body: Buffer;
    let mac: Buffer;
    try {
      body = Buffer.from(bodyB64, 'base64url');
      mac = Buffer.from(macB64, 'base64url');
    } catch {
      throw new CapabilityInvalidError();
    }
    const expected = createHmac('sha256', this.capabilitySecret!).update(body).digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      throw new CapabilityInvalidError('Capability signature invalid.');
    }
    try {
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new CapabilityInvalidError();
    }
  }
}

function isLiveState(state: AttemptRecord['state']): boolean {
  return (
    state === 'queued' ||
    state === 'leased' ||
    state === 'started' ||
    state === 'uploading' ||
    state === 'cancel_requested'
  );
}

function cryptoRandomUuid(): string {
  return randomUUID();
}

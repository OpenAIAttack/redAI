/**
 * Self-contained Fastify plugin for the worker TASK plane (T17): claim, ACK-started,
 * renew, submit-result and attempt-bound input-artifact fetch under `/worker/v1`.
 *
 * Authentication reuses the T15 worker-credential guard: every route is bearer-only
 * (the `Authorization: Bearer` credential, never an owner cookie), via the injected
 * `verifyCredential` resolver. The owner plane is untouched by this plugin.
 *
 * The plugin depends only on small injected ports — a structural {@link ExecutionApi}
 * for the scheduler use cases and an {@link InputArtifactReader} for byte streaming —
 * so it imports no shared server file; the coordinator wires the concrete
 * `ExecutionService` (built from the installation Ed25519 signer) and the storage
 * reader in. Request bodies are validated with `@redai/contracts` (WorkerResult) plus
 * strict inline checks for the request shapes the registry does not carry, and the
 * minted TaskEnvelope is validated against the contract before it leaves the server.
 * Bearer credentials and lease JWS are never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertValidFor, ContractValidationError } from '@redai/contracts';
import { sendError } from '../auth/errors.js';

/** Worker identity resolved from a verified bearer credential (T15 shape). */
export interface WorkerTaskContext {
  workerId: string;
  workspaceId: string;
  credentialId: string;
  zone: string;
  state: string;
}

/** The minted task envelope (matches worker.schema.json#/$defs/TaskEnvelope). */
export interface TaskEnvelope {
  claims: Record<string, unknown>;
  lease_jws: string;
  input: Record<string, unknown>;
  policy_snapshot: Record<string, unknown> | null;
  input_artifact_ids: string[];
}

export interface RenewResult {
  ok: boolean;
  directive: 'continue' | 'cancel' | 'reconcile';
  leaseJws?: string;
  expiresAt?: Date;
  reason?: string;
}

export interface ResultAck {
  accepted: boolean;
  duplicate: boolean;
  authoritative: boolean;
}

/**
 * Structural surface of the scheduler use cases the plugin calls. The concrete
 * `ExecutionService` from `@redai/application/execution` satisfies this; the plugin
 * never imports it (the coordinator injects it). Every method is scoped by the
 * bearer-verified `{ workspaceId, workerId }`.
 */
export interface ExecutionApi {
  claim(scope: WorkerScope, sessionId: string): Promise<TaskEnvelope | null>;
  ack(
    scope: WorkerScope,
    attemptId: string,
    input: {
      sessionId: string;
      fencingToken: string;
      phase: 'accepted' | 'started';
      journalSeq: string;
      containerRef: string | null;
    },
  ): Promise<{ state: string }>;
  renew(
    scope: WorkerScope,
    attemptId: string,
    input: { sessionId: string; fencingToken: string; journalSeq: string; observedState: string },
  ): Promise<RenewResult>;
  submitResult(scope: WorkerScope, attemptId: string, input: SubmitResultInput): Promise<ResultAck>;
  authorizeInputArtifact(
    scope: WorkerScope,
    attemptId: string,
    sessionId: string,
    fencingToken: string,
    artifactId: string,
  ): Promise<void>;
}

export interface WorkerScope {
  workspaceId: string;
  workerId: string;
}

export interface SubmitResultInput {
  sessionId: string;
  fencingToken: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'unknown';
  startedAt: Date | null;
  finishedAt: Date;
  exitCode: number | null;
  summary: string;
  artifactIds: string[];
  structuredResult: Record<string, unknown>;
  outputTruncated: boolean;
  observedQuiescent: boolean;
  effectObservation: 'not_started' | 'completed' | 'unknown';
  resultSha256: string;
  resultJson: Record<string, unknown>;
}

/** Streams the bytes of an attempt-bound input artifact once authorization succeeds. */
export interface InputArtifactReader {
  read(
    workspaceId: string,
    artifactId: string,
  ): Promise<{ contentType: string; bytes: Buffer } | null>;
}

export interface WorkerTasksPluginDeps {
  service: ExecutionApi;
  /** T15 worker-credential verification: bearer → worker context, or throws. */
  verifyCredential: (rawToken: string) => Promise<WorkerTaskContext>;
  inputArtifacts?: InputArtifactReader;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTER_RE = /^(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(.+)$/.exec(header);
  return match ? match[1]!.trim() : null;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/** Map a thrown execution error's code to its HTTP status + envelope code. */
function sendExecutionError(reply: FastifyReply, err: unknown): FastifyReply {
  const code = errorCode(err);
  switch (code) {
    case 'ATTEMPT_NOT_FOUND':
      return sendError(reply, 404, 'ATTEMPT_NOT_FOUND', 'Task attempt not found.');
    case 'ARTIFACT_NOT_LINKED':
      return sendError(
        reply,
        404,
        'ARTIFACT_NOT_LINKED',
        'Artifact is not an input of this attempt.',
      );
    case 'SESSION_SUPERSEDED':
      return sendError(reply, 409, 'SESSION_SUPERSEDED', 'Worker session has been superseded.');
    case 'STALE_FENCE':
      return sendError(reply, 409, 'STALE_FENCE', 'Fencing token is stale.');
    case 'RESULT_CONFLICT':
      return sendError(reply, 409, 'RESULT_CONFLICT', 'A conflicting result was already recorded.');
    case 'CAPABILITY_INVALID':
      return sendError(reply, 403, 'CAPABILITY_INVALID', 'Credential capability is invalid.');
    default:
      throw err;
  }
}

export function registerWorkerTasks(app: FastifyInstance, deps: WorkerTasksPluginDeps): void {
  const { service, verifyCredential } = deps;

  const requireWorker = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<WorkerTaskContext | null> => {
    const token = bearerToken(req);
    if (!token) {
      sendError(reply, 401, 'WORKER_UNAUTHENTICATED', 'Missing worker credential.');
      return null;
    }
    try {
      return await verifyCredential(token);
    } catch (err) {
      if (errorCode(err) === 'WORKER_CREDENTIAL_INVALID') {
        sendError(reply, 401, 'WORKER_UNAUTHENTICATED', 'Invalid worker credential.');
        return null;
      }
      throw err;
    }
  };

  const attemptId = (req: FastifyRequest): string | null => {
    const id = (req.params as { attempt_id?: string }).attempt_id;
    return typeof id === 'string' && UUID_RE.test(id) ? id : null;
  };

  // --- claim -----------------------------------------------------------------------
  app.post('/worker/v1/tasks/claim', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body['session_id'];
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      return sendError(reply, 422, 'INVALID_BODY', 'session_id must be a UUID.');
    }
    const waitSeconds = body['wait_seconds'];
    const manifest = body['manifest_sha256'];
    if (
      typeof waitSeconds !== 'number' ||
      !Number.isInteger(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds > 20 ||
      typeof manifest !== 'string' ||
      !SHA256_RE.test(manifest)
    ) {
      return sendError(reply, 422, 'INVALID_BODY', 'Invalid claim request.');
    }
    const scope = { workspaceId: ctx.workspaceId, workerId: ctx.workerId };
    let envelope: TaskEnvelope | null;
    try {
      envelope = await service.claim(scope, sessionId);
    } catch (err) {
      return sendExecutionError(reply, err);
    }
    if (!envelope) return reply.code(204).send();
    try {
      // The minted envelope must conform to the frozen contract before it leaves us.
      assertValidFor('worker.TaskEnvelope', envelope);
    } catch (err) {
      if (err instanceof ContractValidationError) {
        return sendError(reply, 500, 'ENVELOPE_INVALID', 'Failed to mint a valid task envelope.');
      }
      throw err;
    }
    return reply.code(200).send(envelope);
  });

  // --- ACK -------------------------------------------------------------------------
  app.post('/worker/v1/tasks/:attempt_id/ack', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const id = attemptId(req);
    if (!id) return sendError(reply, 422, 'INVALID_BODY', 'attempt_id must be a UUID.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body['session_id'];
    const fence = body['fencing_token'];
    const phase = body['phase'];
    const journalSeq = body['journal_seq'];
    const containerRef = body['container_ref'];
    if (
      typeof sessionId !== 'string' ||
      !UUID_RE.test(sessionId) ||
      typeof fence !== 'string' ||
      !COUNTER_RE.test(fence) ||
      (phase !== 'accepted' && phase !== 'started') ||
      typeof journalSeq !== 'string' ||
      !COUNTER_RE.test(journalSeq) ||
      !(
        containerRef === null ||
        (typeof containerRef === 'string' && containerRef.length >= 1 && containerRef.length <= 128)
      )
    ) {
      return sendError(reply, 422, 'INVALID_BODY', 'Invalid ACK request.');
    }
    const scope = { workspaceId: ctx.workspaceId, workerId: ctx.workerId };
    try {
      await service.ack(scope, id, {
        sessionId,
        fencingToken: fence,
        phase,
        journalSeq,
        containerRef,
      });
    } catch (err) {
      return sendExecutionError(reply, err);
    }
    return reply.code(200).send({ ok: true });
  });

  // --- renew -----------------------------------------------------------------------
  app.post('/worker/v1/tasks/:attempt_id/renew', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const id = attemptId(req);
    if (!id) return sendError(reply, 422, 'INVALID_BODY', 'attempt_id must be a UUID.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body['session_id'];
    const fence = body['fencing_token'];
    const journalSeq = body['journal_seq'];
    const observedState = body['observed_state'];
    if (
      typeof sessionId !== 'string' ||
      !UUID_RE.test(sessionId) ||
      typeof fence !== 'string' ||
      !COUNTER_RE.test(fence) ||
      typeof journalSeq !== 'string' ||
      !COUNTER_RE.test(journalSeq) ||
      typeof observedState !== 'string'
    ) {
      return sendError(reply, 422, 'INVALID_BODY', 'Invalid renew request.');
    }
    const scope = { workspaceId: ctx.workspaceId, workerId: ctx.workerId };
    let result: RenewResult;
    try {
      result = await service.renew(scope, id, {
        sessionId,
        fencingToken: fence,
        journalSeq,
        observedState,
      });
    } catch (err) {
      return sendExecutionError(reply, err);
    }
    return reply.code(200).send({
      directive: result.directive,
      server_time: new Date().toISOString(),
      lease_jws: result.ok && result.leaseJws ? result.leaseJws : null,
      expires_at: result.ok && result.expiresAt ? result.expiresAt.toISOString() : null,
    });
  });

  // --- result ----------------------------------------------------------------------
  app.post('/worker/v1/tasks/:attempt_id/result', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const id = attemptId(req);
    if (!id) return sendError(reply, 422, 'INVALID_BODY', 'attempt_id must be a UUID.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      assertValidFor('worker.WorkerResult', body);
    } catch (err) {
      if (err instanceof ContractValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid worker result.');
      }
      throw err;
    }
    // The attempt in the URL must match the signed attempt in the body.
    if (body['attempt_id'] !== id) {
      return sendError(reply, 422, 'INVALID_BODY', 'attempt_id mismatch.');
    }
    const scope = { workspaceId: ctx.workspaceId, workerId: ctx.workerId };
    const startedAt = body['started_at'];
    let ack: ResultAck;
    try {
      ack = await service.submitResult(scope, id, {
        // The result's own worker_session_id binds the write to the leasing session.
        sessionId: String(body['worker_session_id']),
        fencingToken: String(body['fencing_token']),
        status: body['status'] as SubmitResultInput['status'],
        startedAt: typeof startedAt === 'string' ? new Date(startedAt) : null,
        finishedAt: new Date(String(body['finished_at'])),
        exitCode: typeof body['exit_code'] === 'number' ? (body['exit_code'] as number) : null,
        summary: String(body['summary'] ?? ''),
        artifactIds: (body['artifact_ids'] as string[]) ?? [],
        structuredResult: (body['structured_result'] as Record<string, unknown>) ?? {},
        outputTruncated: Boolean(body['output_truncated']),
        observedQuiescent: Boolean(body['observed_quiescent']),
        effectObservation: body['effect_observation'] as SubmitResultInput['effectObservation'],
        resultSha256: String(body['result_sha256']),
        resultJson: body,
      });
    } catch (err) {
      return sendExecutionError(reply, err);
    }
    return reply.code(200).send(ack);
  });

  // --- attempt-bound input artifact fetch ------------------------------------------
  app.get('/worker/v1/tasks/:attempt_id/artifacts/:artifact_id/content', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const id = attemptId(req);
    const artifactId = (req.params as { artifact_id?: string }).artifact_id;
    if (!id || typeof artifactId !== 'string' || !UUID_RE.test(artifactId)) {
      return sendError(reply, 422, 'INVALID_BODY', 'attempt_id and artifact_id must be UUIDs.');
    }
    const sessionId = req.headers['x-worker-session'];
    const fence = req.headers['x-fencing-token'];
    if (
      typeof sessionId !== 'string' ||
      !UUID_RE.test(sessionId) ||
      typeof fence !== 'string' ||
      !COUNTER_RE.test(fence)
    ) {
      return sendError(reply, 422, 'INVALID_BODY', 'Missing X-Worker-Session / X-Fencing-Token.');
    }
    const scope = { workspaceId: ctx.workspaceId, workerId: ctx.workerId };
    try {
      await service.authorizeInputArtifact(scope, id, sessionId, fence, artifactId);
    } catch (err) {
      return sendExecutionError(reply, err);
    }
    if (!deps.inputArtifacts) {
      return sendError(reply, 503, 'ARTIFACT_STORE_UNAVAILABLE', 'Artifact store not configured.');
    }
    const content = await deps.inputArtifacts.read(ctx.workspaceId, artifactId);
    if (!content) return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact bytes not found.');
    reply.header('Content-Type', content.contentType);
    return reply.code(200).send(content.bytes);
  });
}

/**
 * Self-contained Fastify plugin for worker enrollment & identity (T15).
 *
 * Two authentication planes that never cross:
 *
 *  - OWNER routes (`/api/v1/workers/*`) are guarded by an INJECTED owner-auth
 *    resolver (`deps.resolveOwner`) that consults the owner SESSION only. A worker
 *    bearer credential in the `Authorization` header is ignored there, so it can
 *    never authenticate an owner endpoint.
 *  - WORKER routes (`/worker/v1/*`) are guarded by this plugin's OWN worker-auth
 *    guard, which consults the `Authorization: Bearer` header only and verifies it
 *    against the worker-credential store. The owner session cookie is ignored there,
 *    so an owner session can never authenticate a worker endpoint.
 *
 * The plugin depends only on small injected ports (`import type` for the owner
 * context; a structural `WorkerIdentityApi` for the use cases) so it does not import
 * or edit any shared server file. Tokens are never logged; the enrollment token and
 * worker credential travel in request/response bodies only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/errors.js';

/** Owner identity resolved from the session by the injected owner-auth adapter. */
export interface OwnerContext {
  workspaceId: string;
  ownerId: string;
}

/** Worker identity resolved from a verified bearer credential. */
export interface WorkerContext {
  workerId: string;
  workspaceId: string;
  credentialId: string;
  zone: string;
  state: string;
}

/** A trusted installation signing key echoed to the worker at enrollment. */
export interface TrustedSigningKey {
  key_id: string;
  algorithm: 'EdDSA';
  public_key_base64url: string;
}

/**
 * Structural surface of the worker-identity use cases the plugin calls. The real
 * `WorkerIdentityService` from `@redai/application` satisfies this without the plugin
 * importing it (the coordinator wires the concrete service in).
 */
export interface WorkerIdentityApi {
  createEnrollmentToken(input: {
    workspaceId: string;
    zone: string;
    displayName?: string;
    capacity?: number;
  }): Promise<{ enrollmentTokenId: string; enrollmentToken: string; zone: string; expiresAt: Date }>;

  redeemEnrollment(input: {
    enrollmentToken: string;
    workerId: string;
    displayName: string;
    arch: string;
    agentVersion: string;
    manifestSha256: string;
    capacity?: number;
  }): Promise<{
    workerId: string;
    workspaceId: string;
    installationId: string;
    workerCredential: string;
    credentialId: string;
    credentialExpiresAt: Date;
  }>;

  verifyCredential(rawToken: string): Promise<WorkerContext>;

  rotateCredential(ctx: {
    workerId: string;
    workspaceId: string;
    credentialId: string;
  }): Promise<{
    workerCredential: string;
    credentialId: string;
    expiresAt: Date;
    oldCredentialValidUntil: Date;
  }>;

  revokeWorker(workerId: string): Promise<void>;

  getWorker(workerId: string): Promise<{
    id: string;
    displayName: string;
    zone: string;
    capacity: number;
    state: string;
    agentVersion: string;
    manifestSha256: string;
    sessionGeneration: string;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
  }>;
}

export interface WorkerIdentityHttpConfig {
  /** Exact origins allowed for owner mutations, on top of same-origin. */
  allowedOrigins: string[];
  /** Installation signing keys echoed in the enrollment response (contract: ≥1). */
  trustedSigningKeys: TrustedSigningKey[];
}

export interface WorkerIdentityPluginDeps {
  service: WorkerIdentityApi;
  /**
   * Injected owner-auth: resolves the owner SESSION (cookie) to a context, or null.
   * MUST NOT consult the `Authorization` header — that keeps worker credentials out
   * of the owner plane. This plugin never imports the concrete owner-auth module.
   */
  resolveOwner: (req: FastifyRequest) => Promise<OwnerContext | null>;
  config: WorkerIdentityHttpConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function originAllowed(req: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  try {
    return typeof host === 'string' && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Extract a Bearer token from the Authorization header (worker plane only). */
function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(.+)$/.exec(header);
  return match ? match[1]!.trim() : null;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string }).code
    : undefined;
}

export function registerWorkerIdentity(app: FastifyInstance, deps: WorkerIdentityPluginDeps): void {
  const { service, resolveOwner, config } = deps;

  /**
   * Worker-auth guard. Consults ONLY the Bearer credential; on failure it replies
   * 401 and returns null so the handler stops. It never reads a cookie, so an owner
   * session cannot pass here.
   */
  const requireWorker = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<WorkerContext | null> => {
    const token = bearerToken(req);
    if (!token) {
      sendError(reply, 401, 'WORKER_UNAUTHENTICATED', 'Missing worker credential.');
      return null;
    }
    try {
      return await service.verifyCredential(token);
    } catch (err) {
      if (errorCode(err) === 'WORKER_CREDENTIAL_INVALID') {
        sendError(reply, 401, 'WORKER_UNAUTHENTICATED', 'Invalid worker credential.');
        return null;
      }
      throw err;
    }
  };

  // --- OWNER plane: session-authenticated, never a worker bearer ------------------

  app.post('/api/v1/workers/enrollment-tokens', async (req, reply) => {
    if (!originAllowed(req, config.allowedOrigins)) {
      return sendError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed.');
    }
    const owner = await resolveOwner(req);
    if (!owner) return sendError(reply, 401, 'UNAUTHENTICATED', 'No valid session.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const zone = body['zone'];
    if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) {
      return sendError(reply, 422, 'INVALID_BODY', 'zone is required.');
    }
    const displayName = typeof body['display_name'] === 'string' ? body['display_name'] : undefined;
    const capacity = typeof body['capacity'] === 'number' ? body['capacity'] : undefined;

    const result = await service.createEnrollmentToken({
      workspaceId: owner.workspaceId,
      zone,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
    });
    return reply.code(201).send({
      enrollment_token_id: result.enrollmentTokenId,
      enrollment_token: result.enrollmentToken,
      zone: result.zone,
      expires_at: result.expiresAt.toISOString(),
    });
  });

  app.post('/api/v1/workers/:worker_id/revoke', async (req, reply) => {
    if (!originAllowed(req, config.allowedOrigins)) {
      return sendError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed.');
    }
    const owner = await resolveOwner(req);
    if (!owner) return sendError(reply, 401, 'UNAUTHENTICATED', 'No valid session.');

    const workerId = (req.params as { worker_id?: string }).worker_id;
    if (typeof workerId !== 'string' || !UUID_RE.test(workerId)) {
      return sendError(reply, 422, 'INVALID_BODY', 'worker_id must be a UUID.');
    }
    try {
      await service.revokeWorker(workerId);
    } catch (err) {
      if (errorCode(err) === 'WORKER_NOT_FOUND') {
        return sendError(reply, 404, 'WORKER_NOT_FOUND', 'Worker not found.');
      }
      throw err;
    }
    return reply.code(204).send();
  });

  // --- WORKER plane: bearer-authenticated, never an owner session -----------------

  app.post('/worker/v1/enroll', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enrollmentToken = body['enrollment_token'];
    const workerId = body['worker_id'];
    const displayName = body['display_name'];
    const os = body['os'];
    const arch = body['arch'];
    const agentVersion = body['agent_version'];
    const manifestSha256 = body['manifest_sha256'];
    const capacity = body['capacity'];

    if (
      typeof enrollmentToken !== 'string' ||
      enrollmentToken.length < 32 ||
      typeof workerId !== 'string' ||
      !UUID_RE.test(workerId) ||
      typeof displayName !== 'string' ||
      displayName.length === 0 ||
      os !== 'linux' ||
      (arch !== 'amd64' && arch !== 'arm64') ||
      typeof agentVersion !== 'string' ||
      agentVersion.length === 0 ||
      typeof manifestSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(manifestSha256) ||
      typeof capacity !== 'number' ||
      !Number.isInteger(capacity)
    ) {
      return sendError(reply, 422, 'INVALID_BODY', 'Invalid enrollment request.');
    }

    try {
      const result = await service.redeemEnrollment({
        enrollmentToken,
        workerId,
        displayName,
        arch,
        agentVersion,
        manifestSha256,
        capacity,
      });
      return reply.code(201).send({
        worker_id: result.workerId,
        worker_credential: result.workerCredential,
        credential_expires_at: result.credentialExpiresAt.toISOString(),
        installation_id: result.installationId,
        trusted_signing_keys: config.trustedSigningKeys,
      });
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENROLLMENT_INVALID' || code === 'ENROLLMENT_ALREADY_CONSUMED') {
        // One generic status: never reveal whether a token exists but was consumed.
        return sendError(reply, 401, 'ENROLLMENT_INVALID', 'Enrollment token is invalid.');
      }
      if (code === 'ENROLLMENT_EXPIRED') {
        return sendError(reply, 401, 'ENROLLMENT_INVALID', 'Enrollment token is invalid.');
      }
      throw err;
    }
  });

  app.get('/worker/v1/identity', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const worker = await service.getWorker(ctx.workerId);
    return reply.code(200).send({
      worker_id: worker.id,
      workspace_id: ctx.workspaceId,
      display_name: worker.displayName,
      zone: worker.zone,
      capacity: worker.capacity,
      state: worker.state,
      agent_version: worker.agentVersion,
      manifest_sha256: worker.manifestSha256,
      session_generation: worker.sessionGeneration,
      last_seen_at: worker.lastSeenAt ? worker.lastSeenAt.toISOString() : null,
    });
  });

  app.post('/worker/v1/credentials/rotate', async (req, reply) => {
    const ctx = await requireWorker(req, reply);
    if (!ctx) return reply;
    const rotated = await service.rotateCredential({
      workerId: ctx.workerId,
      workspaceId: ctx.workspaceId,
      credentialId: ctx.credentialId,
    });
    return reply.code(200).send({
      worker_credential: rotated.workerCredential,
      expires_at: rotated.expiresAt.toISOString(),
      old_credential_valid_until: rotated.oldCredentialValidUntil.toISOString(),
    });
  });
}

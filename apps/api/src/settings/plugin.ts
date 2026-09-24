/**
 * Self-contained Fastify plugin for the settings surface: workspace settings,
 * model/provider configs and secret metadata. Every route sits behind an INJECTED
 * owner-auth guard — this plugin never imports server internals and never touches a
 * worker bearer credential. Responses carry only references + masked metadata; no
 * route ever returns raw secret material.
 *
 * The concrete `SettingsService` and the owner-auth guard are supplied by the
 * coordinator when wiring this into `server.ts`; both are typed structurally here so
 * the plugin builds and tests independently.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/errors.js';
import {
  BodyValidationError,
  parseCreateProviderConfig,
  parseUpdateProviderConfig,
  parseUpdateSettings,
} from './bodySchemas.js';

/** Owner identity resolved from the session (never a worker credential). */
export interface OwnerAuthContext {
  ownerId: string;
  workspaceId: string;
}

/**
 * The owner-auth surface this plugin depends on. The coordinator adapts the auth
 * plugin's session validation + Origin/CSRF checks to this shape. `authenticate`
 * returns `null` for any unauthenticated request; `authorizeMutation` guards
 * state-changing requests (Origin allowlist + CSRF double-submit).
 */
export interface SettingsAuth {
  authenticate(req: FastifyRequest): Promise<OwnerAuthContext | null>;
  authorizeMutation(req: FastifyRequest, ctx: OwnerAuthContext): boolean;
}

interface CreateProviderConfigArgs {
  workspaceId: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  apiKey?: string;
  credentialRef?: string | null;
}

interface UpdateProviderConfigArgs {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  displayName?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Structural view of the application `SettingsService`. Return values are opaque
 * JSON-safe views sent straight to the client, so they are typed `unknown` here and
 * this plugin stays decoupled from the application package's exact view shapes.
 */
export interface SettingsServicePort {
  getSettings(workspaceId: string): Promise<unknown>;
  updateSettings(
    workspaceId: string,
    expectedRevision: number,
    settings: Record<string, unknown>,
  ): Promise<unknown>;
  listProviderConfigs(workspaceId: string): Promise<unknown>;
  getProviderConfig(workspaceId: string, id: string): Promise<unknown>;
  createProviderConfig(input: CreateProviderConfigArgs): Promise<unknown>;
  updateProviderConfig(input: UpdateProviderConfigArgs): Promise<unknown>;
  listSecrets(workspaceId: string): Promise<unknown>;
  revokeSecret(workspaceId: string, id: string): Promise<void>;
}

export interface SettingsPluginDeps {
  service: SettingsServicePort;
  ownerAuth: SettingsAuth;
}

/** Map a settings-domain error `code` to an HTTP status + envelope code. */
function statusForCode(code: string): { status: number; envelope: string } {
  switch (code) {
    case 'REVISION_CONFLICT':
      return { status: 409, envelope: 'REVISION_CONFLICT' };
    case 'SECRET_REVOKED':
    case 'CROSS_PROJECT_SECRET':
    case 'SECRET_ORIGIN_DENIED':
      return { status: 409, envelope: code };
    case 'PROVIDER_CONFIG_NOT_FOUND':
    case 'SECRET_NOT_FOUND':
    case 'CREDENTIAL_NOT_FOUND':
      return { status: 404, envelope: code };
    case 'PROJECT_REQUIRED':
    case 'INVALID_SETTINGS':
      return { status: 422, envelope: code };
    case 'MASTER_KEY_UNAVAILABLE':
      return { status: 503, envelope: 'SECRET_STORE_LOCKED' };
    default:
      return { status: 400, envelope: 'SETTINGS_ERROR' };
  }
}

/** Detect a settings-domain error via its stable marker (no cross-package class import). */
function settingsErrorCode(err: unknown): string | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { isSettingsError?: unknown }).isSettingsError === true &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return null;
}

export function registerSettings(app: FastifyInstance, deps: SettingsPluginDeps): void {
  const { service, ownerAuth } = deps;

  /** Resolve owner or send 401. Returns null when the caller should stop. */
  const requireOwner = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OwnerAuthContext | null> => {
    const ctx = await ownerAuth.authenticate(req);
    if (!ctx) {
      sendError(reply, 401, 'UNAUTHENTICATED', 'No valid session.');
      return null;
    }
    return ctx;
  };

  /** Enforce Origin + CSRF for a mutation; returns false when it already replied. */
  const requireMutation = (
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: OwnerAuthContext,
  ): boolean => {
    if (!ownerAuth.authorizeMutation(req, ctx)) {
      sendError(reply, 403, 'FORBIDDEN', 'Origin or CSRF check failed.');
      return false;
    }
    return true;
  };

  /** Run a service call, translating typed settings errors into the error envelope. */
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      const code = settingsErrorCode(err);
      if (code) {
        const { status, envelope } = statusForCode(code);
        return sendError(reply, status, envelope, (err as Error).message);
      }
      throw err;
    }
  };

  // --- workspace settings ---------------------------------------------------

  app.get('/api/v1/settings', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    return handle(reply, async () =>
      reply.code(200).send(await service.getSettings(ctx.workspaceId)),
    );
  });

  app.put('/api/v1/settings', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    if (!requireMutation(req, reply, ctx)) return reply;
    let body;
    try {
      body = parseUpdateSettings(req.body);
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.');
      }
      throw err;
    }
    return handle(reply, async () =>
      reply
        .code(200)
        .send(await service.updateSettings(ctx.workspaceId, body.expected_revision, body.settings)),
    );
  });

  // --- provider configs -----------------------------------------------------

  app.get('/api/v1/settings/providers', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    return handle(reply, async () =>
      reply.code(200).send({ items: await service.listProviderConfigs(ctx.workspaceId) }),
    );
  });

  app.get('/api/v1/settings/providers/:id', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    const id = (req.params as { id: string }).id;
    return handle(reply, async () =>
      reply.code(200).send(await service.getProviderConfig(ctx.workspaceId, id)),
    );
  });

  app.post('/api/v1/settings/providers', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    if (!requireMutation(req, reply, ctx)) return reply;
    let body;
    try {
      body = parseCreateProviderConfig(req.body);
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.');
      }
      throw err;
    }
    const args: CreateProviderConfigArgs = {
      workspaceId: ctx.workspaceId,
      displayName: body.display_name,
      config: body.config,
    };
    if (body.enabled !== undefined) args.enabled = body.enabled;
    if (body.api_key !== undefined) args.apiKey = body.api_key;
    if (body.credential_ref !== undefined) args.credentialRef = body.credential_ref;
    return handle(reply, async () =>
      reply.code(201).send(await service.createProviderConfig(args)),
    );
  });

  app.patch('/api/v1/settings/providers/:id', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    if (!requireMutation(req, reply, ctx)) return reply;
    const id = (req.params as { id: string }).id;
    let body;
    try {
      body = parseUpdateProviderConfig(req.body);
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.');
      }
      throw err;
    }
    const args: UpdateProviderConfigArgs = {
      workspaceId: ctx.workspaceId,
      id,
      expectedRevision: body.expected_revision,
    };
    if (body.display_name !== undefined) args.displayName = body.display_name;
    if (body.config !== undefined) args.config = body.config;
    if (body.enabled !== undefined) args.enabled = body.enabled;
    return handle(reply, async () =>
      reply.code(200).send(await service.updateProviderConfig(args)),
    );
  });

  // --- secrets (metadata only) ----------------------------------------------

  app.get('/api/v1/settings/secrets', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    return handle(reply, async () =>
      reply.code(200).send({ items: await service.listSecrets(ctx.workspaceId) }),
    );
  });

  app.delete('/api/v1/settings/secrets/:id', async (req, reply) => {
    const ctx = await requireOwner(req, reply);
    if (!ctx) return reply;
    if (!requireMutation(req, reply, ctx)) return reply;
    const id = (req.params as { id: string }).id;
    return handle(reply, async () => {
      await service.revokeSecret(ctx.workspaceId, id);
      return reply.code(204).send();
    });
  });
}

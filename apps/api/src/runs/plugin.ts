/**
 * Self-contained Fastify plugin for runs + chat message history (T09).
 *
 * `registerRuns(app, deps)` mounts the owner-only routes under `/api/v1`, scoped by
 * the authenticated `workspaceId` and the `:projectId`/`:chatId` path segments (the
 * use-case layer filters on the composite keys, so a foreign id resolves to 404 —
 * INV-001). The owner-auth guard is INJECTED so the plugin never imports server
 * internals; the coordinator wires the real cookie/session guard and tests inject a
 * fake.
 *
 * Endpoints:
 *   POST /projects/:projectId/chats/:chatId/runs   — create an Ask run (idempotent).
 *   GET  /projects/:projectId/runs/:runId          — run status.
 *   GET  /projects/:projectId/chats/:chatId/messages — paginated chat history.
 *
 * Creating a run REQUIRES an `Idempotency-Key` (docs/06 §4): a repeated key with the
 * same body replays the same run, a different body is 409 IDEMPOTENCY_CONFLICT, and a
 * double-submit is de-duplicated to exactly one run.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AskService,
  canonicalBodyHash,
  type MessageRecord,
  type RunRecord,
} from '@redai/application/messages';
import { isMessagesError, sendError, sendMessagesError } from './errors.js';
import { BodyValidationError, isUuid, parseCreateRun, parsePageQuery } from './bodySchemas.js';

export interface OwnerContext {
  workspaceId: string;
  ownerId: string;
}

export interface RunsPluginDeps {
  service: AskService;
  authenticate: (req: FastifyRequest) => Promise<OwnerContext | null>;
  authorizeMutation?: (req: FastifyRequest, ctx: OwnerContext) => boolean;
}

const ownerContexts = new WeakMap<FastifyRequest, OwnerContext>();

function runStatusDto(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    workspace_id: run.workspaceId,
    project_id: run.projectId,
    chat_id: run.chatId,
    mode: run.mode,
    kind: run.kind,
    state: run.state,
    outcome: run.outcome,
    provider_config_id: run.providerConfigId,
    step_count: run.stepCount,
    budget_limit_micro_usd: run.budgetLimitMicroUsd,
    stop_reason: run.stopReason,
    expires_at: run.expiresAt.toISOString(),
    revision: run.revision,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  };
}

function artifactIdsOf(m: MessageRecord): string[] {
  const v = m.contentJson['attached_artifact_ids'];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function messageDto(m: MessageRecord): Record<string, unknown> {
  return {
    id: m.id,
    chat_id: m.chatId,
    run_id: m.runId,
    seq: m.seq,
    role: m.role,
    text: m.textContent,
    status: m.status,
    artifact_ids: artifactIdsOf(m),
    created_at: m.createdAt.toISOString(),
  };
}

export function registerRuns(app: FastifyInstance, deps: RunsPluginDeps): void {
  const { service } = deps;
  const authorizeMutation = deps.authorizeMutation ?? (() => true);

  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      await sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
      return;
    }
    ownerContexts.set(req, ctx);
  };

  const requireOwnerMutation = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      await sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
      return;
    }
    if (!authorizeMutation(req, ctx)) {
      await sendError(reply, 403, 'CSRF_INVALID', 'Missing or invalid CSRF/Origin.');
      return;
    }
    ownerContexts.set(req, ctx);
  };

  const owner = (req: FastifyRequest): OwnerContext => {
    const ctx = ownerContexts.get(req);
    if (!ctx) throw new Error('owner context missing after guard');
    return ctx;
  };

  const handle = async (
    reply: FastifyReply,
    fn: () => Promise<FastifyReply>,
  ): Promise<FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.', {
          details: { reason: err.detail.slice(0, 256) },
        });
      }
      if (isMessagesError(err)) return sendMessagesError(reply, err);
      throw err;
    }
  };

  const readGuard = { preHandler: requireOwner };
  const writeGuard = { preHandler: requireOwnerMutation };

  // ------------------------------------------------------------- create run

  app.post('/api/v1/projects/:projectId/chats/:chatId/runs', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId, ownerId } = owner(req);
      const { projectId, chatId } = req.params as { projectId: string; chatId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      if (!isUuid(chatId)) return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found.');

      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !isUuid(idempotencyKey)) {
        return sendError(
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'A UUID Idempotency-Key header is required to create a run.',
        );
      }

      const body = parseCreateRun(req.body);
      if (body.chat_id !== chatId) {
        return sendError(reply, 422, 'INVALID_BODY', 'chat_id does not match the path.');
      }
      if (body.mode !== 'ask') {
        return sendError(
          reply,
          501,
          'NOT_IMPLEMENTED',
          'Only Ask runs are available in this milestone.',
        );
      }

      const bodySha256 = canonicalBodyHash(body as unknown as Record<string, unknown>);
      const result = await service.createAskRun(
        {
          workspaceId,
          projectId,
          chatId,
          providerConfigId: body.provider_config_id,
          text: body.text,
          clientMessageId: body.client_message_id,
          attachedArtifactIds: body.artifact_ids ?? [],
          ...(body.data_mode ? { dataMode: body.data_mode } : {}),
          idempotency: {
            actorKey: ownerId,
            method: 'POST',
            route: `/api/v1/projects/${projectId}/chats/${chatId}/runs`,
            key: idempotencyKey,
          },
        },
        bodySha256,
      );

      return reply.code(result.created ? 201 : 200).send({
        run: runStatusDto(result.run),
        message: messageDto(result.userMessage),
      });
    }),
  );

  // ------------------------------------------------------------- run status

  app.get('/api/v1/projects/:projectId/runs/:runId', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, runId } = req.params as { projectId: string; runId: string };
      if (!isUuid(projectId) || !isUuid(runId)) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found.');
      }
      const run = await service.getRun(workspaceId, projectId, runId);
      return reply.code(200).send(runStatusDto(run));
    }),
  );

  // ---------------------------------------------------------- chat history

  app.get('/api/v1/projects/:projectId/chats/:chatId/messages', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, chatId } = req.params as { projectId: string; chatId: string };
      if (!isUuid(projectId) || !isUuid(chatId)) {
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      }
      const page = parsePageQuery(req.query);
      const result = await service.listMessages(workspaceId, projectId, chatId, {
        limit: page.limit ?? 50,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      });
      return reply.code(200).send({
        items: result.items.map(messageDto),
        next_cursor: result.nextCursor,
      });
    }),
  );
}

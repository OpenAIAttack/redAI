/**
 * Self-contained Fastify plugin for artifact staged-upload, finalize, download and safe
 * preview (T07). Owner-authenticated; the owner-auth guard is INJECTED
 * (`deps.authenticate` / `deps.authorizeMutation`) so this plugin never imports server
 * internals — the coordinator wires the real cookie/session guard and tests inject a
 * fake.
 *
 * Every route is scoped by the authenticated `workspaceId` AND the `:projectId` path
 * segment; the use-case layer filters on the composite `(id, project_id, workspace_id)`
 * key so a download/preview addressed under project A can never read project B's
 * artifact (INV-001). Bytes are addressed by a logical storage key inside the plugin;
 * a host filesystem path is NEVER returned to a client (architecture §1). Downloads are
 * served as `attachment` with `nosniff` so untrusted upload bytes can never render or
 * execute in the browser.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ArtifactRecord, ArtifactsService } from '@redai/application/artifacts';
import { isArtifactsError, sendArtifactsError, sendError } from './errors.js';
import {
  BodyValidationError,
  isUuid,
  parseCreateArtifact,
  parseFinalizeArtifact,
  parsePageQuery,
  readIdempotencyKey,
  sanitizeFilename,
} from './bodySchemas.js';

/** SPEC_LOCK.defaults.upload_max_bytes — the octet-stream body cap. */
const UPLOAD_MAX_BYTES = 26_214_400;

export interface OwnerContext {
  workspaceId: string;
  ownerId: string;
}

export interface ArtifactsPluginDeps {
  service: ArtifactsService;
  authenticate: (req: FastifyRequest) => Promise<OwnerContext | null>;
  authorizeMutation?: (req: FastifyRequest, ctx: OwnerContext) => boolean;
}

const ownerContexts = new WeakMap<FastifyRequest, OwnerContext>();

function toArtifactDto(a: ArtifactRecord): Record<string, unknown> {
  return {
    id: a.id,
    project_id: a.projectId,
    filename: a.filename,
    media_type: a.mediaType,
    byte_size: a.byteSize,
    sha256: a.sha256,
    classification: a.classification,
    status: a.status,
    created_at: a.createdAt.toISOString(),
  };
}

export function registerArtifacts(app: FastifyInstance, deps: ArtifactsPluginDeps): void {
  const { service } = deps;
  const authorizeMutation = deps.authorizeMutation ?? (() => true);

  // Raw-body parser for uploads: collect the octet-stream into a bounded Buffer. The
  // bodyLimit here rejects an oversized upload at parse time (413) before it touches
  // the store. Registered once per server instance.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

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
          details: { reason: err.detail },
        });
      }
      if (isArtifactsError(err)) return sendArtifactsError(reply, err);
      throw err;
    }
  };

  const readGuard = { preHandler: requireOwner };
  const writeGuard = { preHandler: requireOwnerMutation };
  const uploadGuard = { preHandler: requireOwnerMutation, bodyLimit: UPLOAD_MAX_BYTES };

  // -------------------------------------------------------------- list + create

  app.get('/api/v1/projects/:projectId/artifacts', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const page = parsePageQuery(req.query);
      const result = await service.listArtifacts(workspaceId, projectId, {
        ...(page.limit !== undefined ? { limit: page.limit } : {}),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      });
      return reply
        .code(200)
        .send({ items: result.items.map(toArtifactDto), next_cursor: result.nextCursor });
    }),
  );

  app.post('/api/v1/projects/:projectId/artifacts', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      if (!readIdempotencyKey(req.headers as Record<string, unknown>)) {
        return sendError(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Missing Idempotency-Key header.');
      }
      const body = parseCreateArtifact(req.body);
      const created = await service.createUpload(workspaceId, projectId, {
        filename: body.filename,
        mediaType: body.media_type,
        byteSize: body.byte_size,
        sha256: body.sha256,
        classification: body.classification,
      });
      return reply.code(201).send(toArtifactDto(created));
    }),
  );

  // -------------------------------------------------------------------- metadata

  app.get('/api/v1/projects/:projectId/artifacts/:artifactId', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, artifactId } = req.params as { projectId: string; artifactId: string };
      if (!isUuid(projectId) || !isUuid(artifactId))
        return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
      const art = await service.getArtifact(workspaceId, projectId, artifactId);
      return reply.code(200).send(toArtifactDto(art));
    }),
  );

  // ---------------------------------------------------------------- upload bytes

  app.put(
    '/api/v1/projects/:projectId/artifacts/:artifactId/content',
    uploadGuard,
    async (req, reply) =>
      handle(reply, async () => {
        const { workspaceId } = owner(req);
        const { projectId, artifactId } = req.params as { projectId: string; artifactId: string };
        if (!isUuid(projectId) || !isUuid(artifactId))
          return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
        if (!readIdempotencyKey(req.headers as Record<string, unknown>)) {
          return sendError(
            reply,
            400,
            'IDEMPOTENCY_KEY_REQUIRED',
            'Missing Idempotency-Key header.',
          );
        }
        const body = req.body;
        if (!Buffer.isBuffer(body)) {
          return sendError(
            reply,
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Body must be application/octet-stream.',
          );
        }
        await service.putContent(workspaceId, projectId, artifactId, body);
        return reply.code(200).send({ ok: true });
      }),
  );

  // ------------------------------------------------------------------- finalize

  app.post(
    '/api/v1/projects/:projectId/artifacts/:artifactId/finalize',
    writeGuard,
    async (req, reply) =>
      handle(reply, async () => {
        const { workspaceId } = owner(req);
        const { projectId, artifactId } = req.params as { projectId: string; artifactId: string };
        if (!isUuid(projectId) || !isUuid(artifactId))
          return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
        if (!readIdempotencyKey(req.headers as Record<string, unknown>)) {
          return sendError(
            reply,
            400,
            'IDEMPOTENCY_KEY_REQUIRED',
            'Missing Idempotency-Key header.',
          );
        }
        const body = parseFinalizeArtifact(req.body);
        const finalized = await service.finalize(workspaceId, projectId, artifactId, {
          sha256: body.sha256,
          byteSize: body.byte_size,
        });
        return reply.code(200).send(toArtifactDto(finalized));
      }),
  );

  // ------------------------------------------------------------------- download

  app.get(
    '/api/v1/projects/:projectId/artifacts/:artifactId/content',
    readGuard,
    async (req, reply) =>
      handle(reply, async () => {
        const { workspaceId } = owner(req);
        const { projectId, artifactId } = req.params as { projectId: string; artifactId: string };
        if (!isUuid(projectId) || !isUuid(artifactId))
          return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
        const { record, content } = await service.openDownload(workspaceId, projectId, artifactId);
        // Serve untrusted upload bytes defensively: never inline, never sniffed.
        reply
          .header('Content-Type', 'application/octet-stream')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Length', String(content.byteSize))
          .header(
            'Content-Disposition',
            `attachment; filename="${sanitizeFilename(record.filename)}"`,
          );
        return reply.code(200).send(content.stream);
      }),
  );

  // -------------------------------------------------------------------- preview

  app.get(
    '/api/v1/projects/:projectId/artifacts/:artifactId/preview',
    readGuard,
    async (req, reply) =>
      handle(reply, async () => {
        const { workspaceId } = owner(req);
        const { projectId, artifactId } = req.params as { projectId: string; artifactId: string };
        if (!isUuid(projectId) || !isUuid(artifactId))
          return sendError(reply, 404, 'ARTIFACT_NOT_FOUND', 'Artifact not found.');
        const { record, preview } = await service.preview(workspaceId, projectId, artifactId);
        return reply.header('X-Content-Type-Options', 'nosniff').code(200).send({
          artifact_id: record.id,
          media_type: record.mediaType,
          status: record.status,
          preview,
        });
      }),
  );
}

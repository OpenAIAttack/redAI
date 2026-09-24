/**
 * Self-contained Fastify plugin for projects, chats, notes and worker bindings.
 *
 * `registerProjects(app, deps)` mounts the owner-only routes under `/api/v1`. The
 * owner-auth guard is INJECTED (`deps.authenticate`) so this plugin never imports
 * server internals or touches `server.ts` — the coordinator wires the real
 * cookie/session-backed guard, and tests inject a fake. State-changing routes also
 * run `deps.authorizeMutation` (Origin/CSRF), which defaults to allow so the plugin
 * is testable in isolation while the coordinator tightens it in production.
 *
 * Every route is scoped by the authenticated `workspaceId` and, for project-level
 * resources, the `:projectId` path segment; the use-case layer filters on the
 * composite keys so a foreign id resolves to 404, never a cross-project read
 * (INV-001). Handlers surface loading/empty/error/saved states honestly: 200 with a
 * body reflecting the committed row, `{ items, next_cursor }` for lists (empty array
 * for an empty project), and the typed error envelope for failures.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  BindingRecord,
  ChatRecord,
  NoteRecord,
  ProjectRecord,
  ProjectsService,
} from '../../../../packages/application/src/projects/index.js';
import { isProjectsError, sendError, sendProjectsError } from './errors.js';
import {
  BodyValidationError,
  isUuid,
  parseCreateChat,
  parseCreateNote,
  parseCreateProject,
  parseDeleteProject,
  parsePageQuery,
  parseSelectedOnly,
  parseUpdateChat,
  parseUpdateNote,
  parseUpdateProject,
  parseUpsertBinding,
} from './bodySchemas.js';

/** The identity an injected owner guard resolves from the request. */
export interface OwnerContext {
  workspaceId: string;
  ownerId: string;
}

export interface ProjectsPluginDeps {
  service: ProjectsService;
  /**
   * Resolve the authenticated owner from the request, or null when unauthenticated.
   * Production wires the session-cookie guard; tests inject a header-based fake.
   */
  authenticate: (req: FastifyRequest) => Promise<OwnerContext | null>;
  /**
   * Authorise a state-changing request (Origin + CSRF double-submit). Returns false
   * to reject with 403. Defaults to allow so the plugin is unit-testable; the
   * coordinator injects the real check.
   */
  authorizeMutation?: (req: FastifyRequest, ctx: OwnerContext) => boolean;
}

// Per-request owner context, keyed off the request object (no Fastify type mutation).
const ownerContexts = new WeakMap<FastifyRequest, OwnerContext>();

function toProjectDto(p: ProjectRecord): Record<string, unknown> {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    name: p.name,
    description: p.description,
    status: p.status,
    is_inbox: p.isInbox,
    approval_mode: p.approvalMode,
    data_mode: p.dataMode,
    revision: p.revision,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

function toChatDto(c: ChatRecord): Record<string, unknown> {
  return {
    id: c.id,
    workspace_id: c.workspaceId,
    project_id: c.projectId,
    title: c.title,
    pinned: c.pinned,
    revision: c.revision,
    message_seq: c.messageSeq,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

function toNoteDto(n: NoteRecord): Record<string, unknown> {
  return {
    id: n.id,
    workspace_id: n.workspaceId,
    project_id: n.projectId,
    title: n.title,
    content: n.content,
    selected_for_context: n.selectedForContext,
    revision: n.revision,
    created_at: n.createdAt.toISOString(),
    updated_at: n.updatedAt.toISOString(),
  };
}

function toBindingDto(b: BindingRecord): Record<string, unknown> {
  return {
    workspace_id: b.workspaceId,
    project_id: b.projectId,
    worker_id: b.workerId,
    zone: b.zone,
    enabled: b.enabled,
    created_at: b.createdAt.toISOString(),
  };
}

export function registerProjects(app: FastifyInstance, deps: ProjectsPluginDeps): void {
  const { service } = deps;
  const authorizeMutation = deps.authorizeMutation ?? (() => true);

  /** preHandler: require an authenticated owner; 401 otherwise. Stashes the context. */
  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      await sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
      return;
    }
    ownerContexts.set(req, ctx);
  };

  /** preHandler for state-changing routes: owner + Origin/CSRF. */
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

  /** Run a handler, mapping typed use-case + body-validation errors to the envelope. */
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
      if (isProjectsError(err)) return sendProjectsError(reply, err);
      throw err;
    }
  };

  const readGuard = { preHandler: requireOwner };
  const writeGuard = { preHandler: requireOwnerMutation };

  // ------------------------------------------------------------- projects

  app.get('/api/v1/projects', readGuard, async (req, reply) => {
    const { workspaceId } = owner(req);
    const page = parsePageQuery(req.query);
    const result = await service.listProjects(workspaceId, {
      ...(page.limit !== undefined ? { limit: page.limit } : {}),
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    });
    return reply.code(200).send({
      items: result.items.map(toProjectDto),
      next_cursor: result.nextCursor,
    });
  });

  app.get('/api/v1/projects/inbox', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const inbox = await service.getInbox(workspaceId);
      return reply.code(200).send(toProjectDto(inbox));
    }),
  );

  app.post('/api/v1/projects', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const body = parseCreateProject(req.body);
      const created = await service.createProject(workspaceId, {
        name: body.name,
        description: body.description,
        approvalMode: body.approval_mode,
        dataMode: body.data_mode,
      });
      return reply.code(201).send(toProjectDto(created));
    }),
  );

  app.get('/api/v1/projects/:projectId', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const project = await service.getProject(workspaceId, projectId);
      return reply.code(200).send(toProjectDto(project));
    }),
  );

  app.patch('/api/v1/projects/:projectId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseUpdateProject(req.body);
      const updated = await service.updateProject(
        workspaceId,
        projectId,
        String(body.expected_revision),
        {
          name: body.name,
          description: body.description,
          approvalMode: body.approval_mode,
          dataMode: body.data_mode,
        },
      );
      return reply.code(200).send(toProjectDto(updated));
    }),
  );

  app.post('/api/v1/projects/:projectId/archive', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const archived = await service.archiveProject(workspaceId, projectId);
      return reply.code(200).send(toProjectDto(archived));
    }),
  );

  app.post('/api/v1/projects/:projectId/unarchive', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const active = await service.unarchiveProject(workspaceId, projectId);
      return reply.code(200).send(toProjectDto(active));
    }),
  );

  app.delete('/api/v1/projects/:projectId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseDeleteProject(req.body);
      const deleting = await service.deleteProject(workspaceId, projectId, {
        confirmName: body.confirm_name,
      });
      return reply.code(200).send(toProjectDto(deleting));
    }),
  );

  // ---------------------------------------------------------------- chats

  app.get('/api/v1/projects/:projectId/chats', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const page = parsePageQuery(req.query);
      const result = await service.listChats(workspaceId, projectId, {
        ...(page.limit !== undefined ? { limit: page.limit } : {}),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      });
      return reply
        .code(200)
        .send({ items: result.items.map(toChatDto), next_cursor: result.nextCursor });
    }),
  );

  app.post('/api/v1/projects/:projectId/chats', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseCreateChat(req.body);
      const created = await service.createChat(workspaceId, projectId, {
        title: body.title,
        pinned: body.pinned,
      });
      return reply.code(201).send(toChatDto(created));
    }),
  );

  app.get('/api/v1/projects/:projectId/chats/:chatId', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, chatId } = req.params as { projectId: string; chatId: string };
      if (!isUuid(projectId) || !isUuid(chatId))
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      const chat = await service.getChat(workspaceId, projectId, chatId);
      return reply.code(200).send(toChatDto(chat));
    }),
  );

  app.patch('/api/v1/projects/:projectId/chats/:chatId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, chatId } = req.params as { projectId: string; chatId: string };
      if (!isUuid(projectId) || !isUuid(chatId))
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      const body = parseUpdateChat(req.body);
      const updated = await service.updateChat(
        workspaceId,
        projectId,
        chatId,
        String(body.expected_revision),
        {
          title: body.title,
          pinned: body.pinned,
        },
      );
      return reply.code(200).send(toChatDto(updated));
    }),
  );

  app.delete('/api/v1/projects/:projectId/chats/:chatId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, chatId } = req.params as { projectId: string; chatId: string };
      if (!isUuid(projectId) || !isUuid(chatId))
        return sendError(reply, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      await service.deleteChat(workspaceId, projectId, chatId);
      return reply.code(204).send();
    }),
  );

  // ---------------------------------------------------------------- notes

  app.get('/api/v1/projects/:projectId/notes', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const notes = await service.listNotes(workspaceId, projectId, {
        selectedOnly: parseSelectedOnly(req.query),
      });
      return reply.code(200).send({ items: notes.map(toNoteDto) });
    }),
  );

  app.post('/api/v1/projects/:projectId/notes', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseCreateNote(req.body);
      const created = await service.createNote(workspaceId, projectId, {
        title: body.title,
        content: body.content,
        selectedForContext: body.selected_for_context,
      });
      return reply.code(201).send(toNoteDto(created));
    }),
  );

  app.get('/api/v1/projects/:projectId/notes/:noteId', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, noteId } = req.params as { projectId: string; noteId: string };
      if (!isUuid(projectId) || !isUuid(noteId))
        return sendError(reply, 404, 'NOTE_NOT_FOUND', 'Note not found.');
      const note = await service.getNote(workspaceId, projectId, noteId);
      return reply.code(200).send(toNoteDto(note));
    }),
  );

  app.patch('/api/v1/projects/:projectId/notes/:noteId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, noteId } = req.params as { projectId: string; noteId: string };
      if (!isUuid(projectId) || !isUuid(noteId))
        return sendError(reply, 404, 'NOTE_NOT_FOUND', 'Note not found.');
      const body = parseUpdateNote(req.body);
      const updated = await service.updateNote(
        workspaceId,
        projectId,
        noteId,
        String(body.expected_revision),
        {
          title: body.title,
          content: body.content,
          selectedForContext: body.selected_for_context,
        },
      );
      return reply.code(200).send(toNoteDto(updated));
    }),
  );

  app.delete('/api/v1/projects/:projectId/notes/:noteId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, noteId } = req.params as { projectId: string; noteId: string };
      if (!isUuid(projectId) || !isUuid(noteId))
        return sendError(reply, 404, 'NOTE_NOT_FOUND', 'Note not found.');
      await service.deleteNote(workspaceId, projectId, noteId);
      return reply.code(204).send();
    }),
  );

  // ------------------------------------------------------------- bindings

  app.get('/api/v1/projects/:projectId/workers', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const bindings = await service.listBindings(workspaceId, projectId);
      return reply.code(200).send({ items: bindings.map(toBindingDto) });
    }),
  );

  app.put('/api/v1/projects/:projectId/workers/:workerId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, workerId } = req.params as { projectId: string; workerId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      if (!isUuid(workerId)) return sendError(reply, 404, 'WORKER_NOT_FOUND', 'Worker not found.');
      const body = parseUpsertBinding(req.body);
      const binding = await service.upsertBinding(workspaceId, projectId, workerId, {
        zone: body.zone,
        enabled: body.enabled,
      });
      return reply.code(200).send(toBindingDto(binding));
    }),
  );

  app.delete('/api/v1/projects/:projectId/workers/:workerId', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, workerId } = req.params as { projectId: string; workerId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      if (!isUuid(workerId))
        return sendError(reply, 404, 'BINDING_NOT_FOUND', 'Binding not found.');
      await service.deleteBinding(workspaceId, projectId, workerId);
      return reply.code(204).send();
    }),
  );
}

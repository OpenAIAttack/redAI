/**
 * Project / Chat / Note / worker-binding use cases (T06).
 *
 * Pure orchestration over the injected {@link ProjectsRepository} plus a clock and a
 * UUID source — it opens no sockets and reads no globals, so the unit tests drive it
 * with an in-memory fake. Cross-project isolation (INV-001) is enforced structurally:
 * every method threads `workspaceId` (+ `projectId` for project-level entities) into
 * the repository, which filters on the composite `(id, project_id, workspace_id)`
 * keys. A UUID from another project therefore resolves to a typed *NotFound*, never a
 * cross-project read/write.
 *
 * Owner-only authority (INV-011): these use cases are reached only from the owner
 * API/session — model output never calls them. The service itself does not
 * authenticate; the API layer's injected owner guard does.
 */
import { cryptoRandom, systemClock } from '../auth/crypto.js';
import { decodeCursor } from './cursor.js';
import {
  BindingNotFoundError,
  ChatHasActiveRunError,
  ChatNotFoundError,
  InboxProtectedError,
  NameConfirmationMismatchError,
  NoteNotFoundError,
  ProjectHasActiveRunError,
  ProjectNotActiveError,
  ProjectNotFoundError,
  RevisionConflictError,
  WorkerNotFoundError,
} from './errors.js';
import type {
  BindingRecord,
  ChatRecord,
  Clock,
  CreateChatFields,
  CreateNoteFields,
  CreateProjectFields,
  NoteRecord,
  Page,
  PageQuery,
  ProjectRecord,
  ProjectsRepository,
  RandomSource,
  UpdateChatFields,
  UpdateNoteFields,
  UpdateProjectFields,
  UpsertBindingFields,
} from './ports.js';

/** Default page size for cursor lists; bounded so a single query stays cheap. */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface ProjectsServiceDeps {
  repo: ProjectsRepository;
  clock?: Clock;
  random?: RandomSource;
  defaultPageLimit?: number;
  maxPageLimit?: number;
}

export interface DeleteProjectInput {
  /** The owner must re-type the exact project name to confirm a destructive delete. */
  confirmName: string;
}

function normalizePage(
  requested: number | undefined,
  def: number,
  max: number,
  cursor: string | undefined,
): PageQuery {
  const limit = Math.min(max, Math.max(1, Math.trunc(requested ?? def)));
  // Drop a malformed cursor rather than 500 — the list restarts from the top.
  const clean = decodeCursor(cursor) ? cursor : undefined;
  return { limit, cursor: clean };
}

export class ProjectsService {
  private readonly repo: ProjectsRepository;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly def: number;
  private readonly max: number;

  public constructor(deps: ProjectsServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? cryptoRandom;
    this.def = deps.defaultPageLimit ?? DEFAULT_PAGE_LIMIT;
    this.max = deps.maxPageLimit ?? MAX_PAGE_LIMIT;
  }

  // ---------------------------------------------------------------- projects

  async createProject(workspaceId: string, fields: CreateProjectFields): Promise<ProjectRecord> {
    return this.repo.createProject(workspaceId, this.random.uuid(), fields);
  }

  async getProject(workspaceId: string, projectId: string): Promise<ProjectRecord> {
    const row = await this.repo.getProject(workspaceId, projectId);
    if (!row) throw new ProjectNotFoundError();
    return row;
  }

  /** The system Inbox project (created at bootstrap; docs/05 §2). */
  async getInbox(workspaceId: string): Promise<ProjectRecord> {
    const row = await this.repo.getInbox(workspaceId);
    if (!row) throw new ProjectNotFoundError();
    return row;
  }

  async listProjects(
    workspaceId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ProjectRecord>> {
    return this.repo.listProjects(
      workspaceId,
      normalizePage(opts.limit, this.def, this.max, opts.cursor),
    );
  }

  async updateProject(
    workspaceId: string,
    projectId: string,
    expectedRevision: string,
    fields: UpdateProjectFields,
  ): Promise<ProjectRecord> {
    const result = await this.repo.updateProject(workspaceId, projectId, expectedRevision, fields);
    if (result === 'not-found') throw new ProjectNotFoundError();
    if (result === 'conflict') {
      const current = await this.repo.getProject(workspaceId, projectId);
      throw new RevisionConflictError(expectedRevision, current?.revision ?? 'unknown');
    }
    return result;
  }

  /** Archive keeps every row; it only flips status active → archived (docs/05 §6). */
  async archiveProject(workspaceId: string, projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(workspaceId, projectId);
    if (project.isInbox) throw new InboxProtectedError();
    const row = await this.repo.setProjectStatus(workspaceId, projectId, ['active'], 'archived');
    if (row === 'not-found') {
      // Either it vanished or it was not active. Re-read to give the precise error.
      const cur = await this.repo.getProject(workspaceId, projectId);
      if (!cur) throw new ProjectNotFoundError();
      return cur; // already archived → idempotent success
    }
    return row;
  }

  async unarchiveProject(workspaceId: string, projectId: string): Promise<ProjectRecord> {
    const project = await this.getProject(workspaceId, projectId);
    const row = await this.repo.setProjectStatus(workspaceId, projectId, ['archived'], 'active');
    if (row === 'not-found') {
      if (project.status === 'active') return project; // idempotent
      throw new ProjectNotFoundError();
    }
    return row;
  }

  /**
   * Begin project deletion (docs/03 §5, docs/05 §6): requires the exact name typed
   * back, refuses the Inbox, and blocks while an active run exists (INV-002). It sets
   * status → `deleting` (a tombstone); the batched purge job is a later task. Delete
   * is *not* archive: archive preserves data and is reversible.
   */
  async deleteProject(
    workspaceId: string,
    projectId: string,
    input: DeleteProjectInput,
  ): Promise<ProjectRecord> {
    const project = await this.getProject(workspaceId, projectId);
    if (project.isInbox) throw new InboxProtectedError();
    if (input.confirmName !== project.name) throw new NameConfirmationMismatchError();
    const active = await this.repo.countActiveRunsForProject(workspaceId, projectId);
    if (active > 0) throw new ProjectHasActiveRunError();
    const row = await this.repo.setProjectStatus(
      workspaceId,
      projectId,
      ['active', 'archived'],
      'deleting',
    );
    if (row === 'not-found') {
      const cur = await this.repo.getProject(workspaceId, projectId);
      if (!cur) throw new ProjectNotFoundError();
      return cur; // already deleting/deleted → idempotent
    }
    return row;
  }

  // ------------------------------------------------------------------- chats

  private async requireActiveProject(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectRecord> {
    const project = await this.getProject(workspaceId, projectId);
    if (project.status !== 'active') throw new ProjectNotActiveError();
    return project;
  }

  async createChat(
    workspaceId: string,
    projectId: string,
    fields: CreateChatFields,
  ): Promise<ChatRecord> {
    await this.requireActiveProject(workspaceId, projectId);
    return this.repo.createChat(workspaceId, projectId, this.random.uuid(), fields);
  }

  async getChat(workspaceId: string, projectId: string, chatId: string): Promise<ChatRecord> {
    const row = await this.repo.getChat(workspaceId, projectId, chatId);
    if (!row) throw new ChatNotFoundError();
    return row;
  }

  async listChats(
    workspaceId: string,
    projectId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<Page<ChatRecord>> {
    await this.getProject(workspaceId, projectId); // 404 for unknown/foreign project
    return this.repo.listChats(
      workspaceId,
      projectId,
      normalizePage(opts.limit, this.def, this.max, opts.cursor),
    );
  }

  async updateChat(
    workspaceId: string,
    projectId: string,
    chatId: string,
    expectedRevision: string,
    fields: UpdateChatFields,
  ): Promise<ChatRecord> {
    const result = await this.repo.updateChat(
      workspaceId,
      projectId,
      chatId,
      expectedRevision,
      fields,
    );
    if (result === 'not-found') throw new ChatNotFoundError();
    if (result === 'conflict') {
      const current = await this.repo.getChat(workspaceId, projectId, chatId);
      throw new RevisionConflictError(expectedRevision, current?.revision ?? 'unknown');
    }
    return result;
  }

  /** Deleting a chat is blocked while it has an active run (docs/03 §5). */
  async deleteChat(workspaceId: string, projectId: string, chatId: string): Promise<void> {
    await this.getChat(workspaceId, projectId, chatId); // 404 if foreign/unknown
    const active = await this.repo.countActiveRunsForChat(workspaceId, projectId, chatId);
    if (active > 0) throw new ChatHasActiveRunError();
    const ok = await this.repo.deleteChat(workspaceId, projectId, chatId);
    if (!ok) throw new ChatNotFoundError();
  }

  // ------------------------------------------------------------------- notes

  async createNote(
    workspaceId: string,
    projectId: string,
    fields: CreateNoteFields,
  ): Promise<NoteRecord> {
    await this.requireActiveProject(workspaceId, projectId);
    return this.repo.createNote(workspaceId, projectId, this.random.uuid(), fields);
  }

  async getNote(workspaceId: string, projectId: string, noteId: string): Promise<NoteRecord> {
    const row = await this.repo.getNote(workspaceId, projectId, noteId);
    if (!row) throw new NoteNotFoundError();
    return row;
  }

  async listNotes(
    workspaceId: string,
    projectId: string,
    opts: { selectedOnly?: boolean } = {},
  ): Promise<NoteRecord[]> {
    await this.getProject(workspaceId, projectId);
    return this.repo.listNotes(workspaceId, projectId, { selectedOnly: opts.selectedOnly });
  }

  /**
   * The exact set a context builder (T09 Ask) reads: project notes with
   * `selected_for_context = true`. Kept as a first-class read so "selected" is a real
   * server-side filter, not UI state.
   */
  async listSelectedNotesForContext(workspaceId: string, projectId: string): Promise<NoteRecord[]> {
    await this.getProject(workspaceId, projectId);
    return this.repo.listNotes(workspaceId, projectId, { selectedOnly: true });
  }

  async updateNote(
    workspaceId: string,
    projectId: string,
    noteId: string,
    expectedRevision: string,
    fields: UpdateNoteFields,
  ): Promise<NoteRecord> {
    const result = await this.repo.updateNote(
      workspaceId,
      projectId,
      noteId,
      expectedRevision,
      fields,
    );
    if (result === 'not-found') throw new NoteNotFoundError();
    if (result === 'conflict') {
      const current = await this.repo.getNote(workspaceId, projectId, noteId);
      throw new RevisionConflictError(expectedRevision, current?.revision ?? 'unknown');
    }
    return result;
  }

  async deleteNote(workspaceId: string, projectId: string, noteId: string): Promise<void> {
    const ok = await this.repo.deleteNote(workspaceId, projectId, noteId);
    if (!ok) throw new NoteNotFoundError();
  }

  // ---------------------------------------------------------------- bindings

  async listBindings(workspaceId: string, projectId: string): Promise<BindingRecord[]> {
    await this.getProject(workspaceId, projectId);
    return this.repo.listBindings(workspaceId, projectId);
  }

  /**
   * Configure a project→worker binding (owner-only, INV-011). This writes only the
   * BINDING CONFIG (zone + enabled); it never creates or mutates worker identity or
   * credentials (owned by T15). A worker that does not exist in this workspace yields
   * a typed WorkerNotFound rather than an FK 500.
   */
  async upsertBinding(
    workspaceId: string,
    projectId: string,
    workerId: string,
    fields: UpsertBindingFields,
  ): Promise<BindingRecord> {
    await this.getProject(workspaceId, projectId);
    const result = await this.repo.upsertBinding(workspaceId, projectId, workerId, fields);
    if (result === 'worker-not-found') throw new WorkerNotFoundError();
    return result;
  }

  async deleteBinding(workspaceId: string, projectId: string, workerId: string): Promise<void> {
    const ok = await this.repo.deleteBinding(workspaceId, projectId, workerId);
    if (!ok) throw new BindingNotFoundError();
  }
}

/**
 * Injected collaborators and the storage port for the project/chat/note/binding
 * use cases. Time and randomness sit behind tiny interfaces so unit tests drive a
 * deterministic clock and a scripted UUID source; the DB adapter wires the real
 * ones. No `pg` / `@redai/db` type leaks across this boundary — records are
 * DB-shape-neutral (camelCase, `revision` as a decimal string per docs/05).
 */

/** Monotonic source of "now"; the only way a use case learns the wall clock. */
export interface Clock {
  now(): Date;
}

/** Cryptographically strong randomness. Only UUIDs are needed by these use cases. */
export interface RandomSource {
  /** A random UUID (v4) for a new project/chat/note primary key. */
  uuid(): string;
}

export type ProjectStatus = 'active' | 'archived' | 'deleting' | 'deleted';
export type ApprovalMode = 'automatic' | 'always_ask' | 'ask_high_risk' | 'reject';
export type DataMode = 'local_only' | 'redacted_cloud' | 'cloud_full';

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: ProjectStatus;
  isInbox: boolean;
  approvalMode: ApprovalMode;
  dataMode: DataMode;
  /** bigint transmitted as a decimal string (docs/05 §1). */
  revision: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  pinned: boolean;
  revision: string;
  messageSeq: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  content: string;
  selectedForContext: boolean;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BindingRecord {
  workspaceId: string;
  projectId: string;
  workerId: string;
  zone: string;
  enabled: boolean;
  createdAt: Date;
}

/** Opaque, keyset (cursor) pagination window. `cursor` is the last item's key. */
export interface PageQuery {
  limit: number;
  /** Opaque cursor produced by a previous page (encodes updatedAt + id). */
  cursor?: string | undefined;
}

export interface Page<T> {
  items: T[];
  /** Cursor to fetch the next page, or null when the last page was returned. */
  nextCursor: string | null;
}

export interface CreateProjectFields {
  name: string;
  description?: string | undefined;
  approvalMode?: ApprovalMode | undefined;
  dataMode?: DataMode | undefined;
}

export interface UpdateProjectFields {
  name?: string | undefined;
  description?: string | undefined;
  approvalMode?: ApprovalMode | undefined;
  dataMode?: DataMode | undefined;
}

export interface CreateChatFields {
  title?: string | undefined;
  pinned?: boolean | undefined;
}

export interface UpdateChatFields {
  title?: string | undefined;
  pinned?: boolean | undefined;
}

export interface CreateNoteFields {
  title: string;
  content: string;
  selectedForContext?: boolean | undefined;
}

export interface UpdateNoteFields {
  title?: string | undefined;
  content?: string | undefined;
  selectedForContext?: boolean | undefined;
}

export interface UpsertBindingFields {
  zone: string;
  enabled?: boolean | undefined;
}

/**
 * Storage port. EVERY read and write is scoped by `workspaceId` and, for
 * project-level entities, `projectId` — a request scoped to project A must never
 * touch project B (INV-001). The DB adapter enforces this with explicit predicates
 * on the composite `(id, project_id, workspace_id)` keys; the in-memory fake mirrors
 * the same filtering. Optimistic-concurrency updates return `'not-found'` vs
 * `'conflict'` so the service can raise the right typed error.
 */
export interface ProjectsRepository {
  // --- projects ---
  createProject(
    workspaceId: string,
    id: string,
    fields: CreateProjectFields,
  ): Promise<ProjectRecord>;
  getProject(workspaceId: string, projectId: string): Promise<ProjectRecord | null>;
  getInbox(workspaceId: string): Promise<ProjectRecord | null>;
  listProjects(workspaceId: string, page: PageQuery): Promise<Page<ProjectRecord>>;
  /** Optimistic update of project metadata; requires the row's current revision. */
  updateProject(
    workspaceId: string,
    projectId: string,
    expectedRevision: string,
    fields: UpdateProjectFields,
  ): Promise<ProjectRecord | 'not-found' | 'conflict'>;
  /**
   * Transition project status among the allowed set. `from` lists the states the
   * row may currently be in; returns the updated record, `'not-found'` (unknown /
   * wrong workspace / not in `from`) — the caller has already checked Inbox/active-run
   * guards inside the same transaction.
   */
  setProjectStatus(
    workspaceId: string,
    projectId: string,
    from: readonly ProjectStatus[],
    to: ProjectStatus,
  ): Promise<ProjectRecord | 'not-found'>;
  /** Count runs on the project that are in an active (non-terminal) state (INV-002). */
  countActiveRunsForProject(workspaceId: string, projectId: string): Promise<number>;

  // --- chats ---
  createChat(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: CreateChatFields,
  ): Promise<ChatRecord>;
  getChat(workspaceId: string, projectId: string, chatId: string): Promise<ChatRecord | null>;
  listChats(workspaceId: string, projectId: string, page: PageQuery): Promise<Page<ChatRecord>>;
  updateChat(
    workspaceId: string,
    projectId: string,
    chatId: string,
    expectedRevision: string,
    fields: UpdateChatFields,
  ): Promise<ChatRecord | 'not-found' | 'conflict'>;
  deleteChat(workspaceId: string, projectId: string, chatId: string): Promise<boolean>;
  countActiveRunsForChat(workspaceId: string, projectId: string, chatId: string): Promise<number>;

  // --- notes ---
  createNote(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: CreateNoteFields,
  ): Promise<NoteRecord>;
  getNote(workspaceId: string, projectId: string, noteId: string): Promise<NoteRecord | null>;
  listNotes(
    workspaceId: string,
    projectId: string,
    opts: { selectedOnly?: boolean | undefined },
  ): Promise<NoteRecord[]>;
  updateNote(
    workspaceId: string,
    projectId: string,
    noteId: string,
    expectedRevision: string,
    fields: UpdateNoteFields,
  ): Promise<NoteRecord | 'not-found' | 'conflict'>;
  deleteNote(workspaceId: string, projectId: string, noteId: string): Promise<boolean>;

  // --- worker bindings (binding config only; worker identity belongs to T15) ---
  listBindings(workspaceId: string, projectId: string): Promise<BindingRecord[]>;
  /**
   * Insert-or-update the project→worker binding config. Returns `'worker-not-found'`
   * when the worker/zone does not exist in this workspace (composite FK unsatisfied),
   * never creating a worker.
   */
  upsertBinding(
    workspaceId: string,
    projectId: string,
    workerId: string,
    fields: UpsertBindingFields,
  ): Promise<BindingRecord | 'worker-not-found'>;
  deleteBinding(workspaceId: string, projectId: string, workerId: string): Promise<boolean>;
}

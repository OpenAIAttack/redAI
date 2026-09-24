/**
 * In-memory {@link ProjectsRepository} for the service unit tests. It mirrors the
 * DB adapter's SEMANTICS — cross-project filtering on the composite key, the Inbox
 * partial-unique guard, optimistic `revision` bumps, keyset pagination and the
 * binding FK check — without a database, so the fast suite exercises the same
 * invariants the SQL enforces. The DB adapter's own test proves the SQL matches.
 */
import { encodeCursor } from './cursor.js';
import { InboxExistsError } from './errors.js';
import type {
  BindingRecord,
  ChatRecord,
  CreateChatFields,
  CreateNoteFields,
  CreateProjectFields,
  NoteRecord,
  Page,
  PageQuery,
  ProjectRecord,
  ProjectsRepository,
  ProjectStatus,
  UpdateChatFields,
  UpdateNoteFields,
  UpdateProjectFields,
  UpsertBindingFields,
} from './ports.js';

interface Clocklike {
  now(): Date;
}

/** A worker row the fake knows about, so binding FK checks can pass in unit tests. */
export interface FakeWorker {
  workspaceId: string;
  workerId: string;
  zone: string;
}

/** A run row the fake knows about, so active-run guards can be exercised. */
export interface FakeRun {
  workspaceId: string;
  projectId: string;
  chatId: string;
  active: boolean;
}

export class InMemoryProjectsRepository implements ProjectsRepository {
  private projects = new Map<string, ProjectRecord>();
  private chats = new Map<string, ChatRecord>();
  private notes = new Map<string, NoteRecord>();
  private bindings = new Map<string, BindingRecord>();
  public workers: FakeWorker[] = [];
  public runs: FakeRun[] = [];
  private seq = 0;

  public constructor(private readonly clock: Clocklike) {}

  private tick(): Date {
    // Monotonic, strictly-increasing timestamps so updated_at ordering is total.
    this.seq += 1;
    return new Date(this.clock.now().getTime() + this.seq);
  }

  private static bindingKey(projectId: string, workerId: string): string {
    return `${projectId}:${workerId}`;
  }

  // ---------------------------------------------------------------- projects

  async createProject(
    workspaceId: string,
    id: string,
    fields: CreateProjectFields,
  ): Promise<ProjectRecord> {
    const now = this.tick();
    const rec: ProjectRecord = {
      id,
      workspaceId,
      name: fields.name,
      description: fields.description ?? '',
      status: 'active',
      isInbox: false,
      approvalMode: fields.approvalMode ?? 'automatic',
      dataMode: fields.dataMode ?? 'redacted_cloud',
      revision: '1',
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, rec);
    return { ...rec };
  }

  /** Test helper: seed the system Inbox (partial-unique enforced like `one_inbox`). */
  async createInbox(workspaceId: string, id: string, name = 'Inbox'): Promise<ProjectRecord> {
    for (const p of this.projects.values()) {
      if (p.workspaceId === workspaceId && p.isInbox) throw new InboxExistsError();
    }
    const now = this.tick();
    const rec: ProjectRecord = {
      id,
      workspaceId,
      name,
      description: 'System inbox project',
      status: 'active',
      isInbox: true,
      approvalMode: 'automatic',
      dataMode: 'redacted_cloud',
      revision: '1',
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, rec);
    return { ...rec };
  }

  async getProject(workspaceId: string, projectId: string): Promise<ProjectRecord | null> {
    const p = this.projects.get(projectId);
    return p && p.workspaceId === workspaceId ? { ...p } : null;
  }

  async getInbox(workspaceId: string): Promise<ProjectRecord | null> {
    for (const p of this.projects.values()) {
      if (p.workspaceId === workspaceId && p.isInbox) return { ...p };
    }
    return null;
  }

  async listProjects(workspaceId: string, page: PageQuery): Promise<Page<ProjectRecord>> {
    const all = [...this.projects.values()]
      .filter((p) => p.workspaceId === workspaceId && p.status !== 'deleted')
      .sort(compareByUpdatedDesc);
    return paginate(all, page);
  }

  async updateProject(
    workspaceId: string,
    projectId: string,
    expectedRevision: string,
    fields: UpdateProjectFields,
  ): Promise<ProjectRecord | 'not-found' | 'conflict'> {
    const p = this.projects.get(projectId);
    if (!p || p.workspaceId !== workspaceId) return 'not-found';
    if (p.revision !== expectedRevision) return 'conflict';
    if (fields.name !== undefined) p.name = fields.name;
    if (fields.description !== undefined) p.description = fields.description;
    if (fields.approvalMode !== undefined) p.approvalMode = fields.approvalMode;
    if (fields.dataMode !== undefined) p.dataMode = fields.dataMode;
    p.revision = String(BigInt(p.revision) + 1n);
    p.updatedAt = this.tick();
    return { ...p };
  }

  async setProjectStatus(
    workspaceId: string,
    projectId: string,
    from: readonly ProjectStatus[],
    to: ProjectStatus,
  ): Promise<ProjectRecord | 'not-found'> {
    const p = this.projects.get(projectId);
    if (!p || p.workspaceId !== workspaceId || !from.includes(p.status)) return 'not-found';
    p.status = to;
    p.revision = String(BigInt(p.revision) + 1n);
    p.updatedAt = this.tick();
    return { ...p };
  }

  async countActiveRunsForProject(workspaceId: string, projectId: string): Promise<number> {
    return this.runs.filter(
      (r) => r.workspaceId === workspaceId && r.projectId === projectId && r.active,
    ).length;
  }

  // ------------------------------------------------------------------- chats

  async createChat(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: CreateChatFields,
  ): Promise<ChatRecord> {
    const now = this.tick();
    const rec: ChatRecord = {
      id,
      workspaceId,
      projectId,
      title: fields.title ?? '',
      pinned: fields.pinned ?? false,
      revision: '1',
      messageSeq: '0',
      createdAt: now,
      updatedAt: now,
    };
    this.chats.set(id, rec);
    return { ...rec };
  }

  async getChat(
    workspaceId: string,
    projectId: string,
    chatId: string,
  ): Promise<ChatRecord | null> {
    const c = this.chats.get(chatId);
    return c && c.workspaceId === workspaceId && c.projectId === projectId ? { ...c } : null;
  }

  async listChats(
    workspaceId: string,
    projectId: string,
    page: PageQuery,
  ): Promise<Page<ChatRecord>> {
    const all = [...this.chats.values()]
      .filter((c) => c.workspaceId === workspaceId && c.projectId === projectId)
      .sort(compareByUpdatedDesc);
    return paginate(all, page);
  }

  async updateChat(
    workspaceId: string,
    projectId: string,
    chatId: string,
    expectedRevision: string,
    fields: UpdateChatFields,
  ): Promise<ChatRecord | 'not-found' | 'conflict'> {
    const c = this.chats.get(chatId);
    if (!c || c.workspaceId !== workspaceId || c.projectId !== projectId) return 'not-found';
    if (c.revision !== expectedRevision) return 'conflict';
    if (fields.title !== undefined) c.title = fields.title;
    if (fields.pinned !== undefined) c.pinned = fields.pinned;
    c.revision = String(BigInt(c.revision) + 1n);
    c.updatedAt = this.tick();
    return { ...c };
  }

  async deleteChat(workspaceId: string, projectId: string, chatId: string): Promise<boolean> {
    const c = this.chats.get(chatId);
    if (!c || c.workspaceId !== workspaceId || c.projectId !== projectId) return false;
    this.chats.delete(chatId);
    return true;
  }

  async countActiveRunsForChat(
    workspaceId: string,
    projectId: string,
    chatId: string,
  ): Promise<number> {
    return this.runs.filter(
      (r) =>
        r.workspaceId === workspaceId &&
        r.projectId === projectId &&
        r.chatId === chatId &&
        r.active,
    ).length;
  }

  // ------------------------------------------------------------------- notes

  async createNote(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: CreateNoteFields,
  ): Promise<NoteRecord> {
    const now = this.tick();
    const rec: NoteRecord = {
      id,
      workspaceId,
      projectId,
      title: fields.title,
      content: fields.content,
      selectedForContext: fields.selectedForContext ?? true,
      revision: '1',
      createdAt: now,
      updatedAt: now,
    };
    this.notes.set(id, rec);
    return { ...rec };
  }

  async getNote(
    workspaceId: string,
    projectId: string,
    noteId: string,
  ): Promise<NoteRecord | null> {
    const n = this.notes.get(noteId);
    return n && n.workspaceId === workspaceId && n.projectId === projectId ? { ...n } : null;
  }

  async listNotes(
    workspaceId: string,
    projectId: string,
    opts: { selectedOnly?: boolean | undefined },
  ): Promise<NoteRecord[]> {
    return [...this.notes.values()]
      .filter(
        (n) =>
          n.workspaceId === workspaceId &&
          n.projectId === projectId &&
          (opts.selectedOnly ? n.selectedForContext : true),
      )
      .sort(compareByUpdatedDesc)
      .map((n) => ({ ...n }));
  }

  async updateNote(
    workspaceId: string,
    projectId: string,
    noteId: string,
    expectedRevision: string,
    fields: UpdateNoteFields,
  ): Promise<NoteRecord | 'not-found' | 'conflict'> {
    const n = this.notes.get(noteId);
    if (!n || n.workspaceId !== workspaceId || n.projectId !== projectId) return 'not-found';
    if (n.revision !== expectedRevision) return 'conflict';
    if (fields.title !== undefined) n.title = fields.title;
    if (fields.content !== undefined) n.content = fields.content;
    if (fields.selectedForContext !== undefined) n.selectedForContext = fields.selectedForContext;
    n.revision = String(BigInt(n.revision) + 1n);
    n.updatedAt = this.tick();
    return { ...n };
  }

  async deleteNote(workspaceId: string, projectId: string, noteId: string): Promise<boolean> {
    const n = this.notes.get(noteId);
    if (!n || n.workspaceId !== workspaceId || n.projectId !== projectId) return false;
    this.notes.delete(noteId);
    return true;
  }

  // ---------------------------------------------------------------- bindings

  async listBindings(workspaceId: string, projectId: string): Promise<BindingRecord[]> {
    return [...this.bindings.values()]
      .filter((b) => b.workspaceId === workspaceId && b.projectId === projectId)
      .sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0))
      .map((b) => ({ ...b }));
  }

  async upsertBinding(
    workspaceId: string,
    projectId: string,
    workerId: string,
    fields: UpsertBindingFields,
  ): Promise<BindingRecord | 'worker-not-found'> {
    const worker = this.workers.find(
      (w) => w.workspaceId === workspaceId && w.workerId === workerId && w.zone === fields.zone,
    );
    if (!worker) return 'worker-not-found';
    const key = InMemoryProjectsRepository.bindingKey(projectId, workerId);
    const existing = this.bindings.get(key);
    const rec: BindingRecord = {
      workspaceId,
      projectId,
      workerId,
      zone: fields.zone,
      enabled: fields.enabled ?? true,
      createdAt: existing?.createdAt ?? this.tick(),
    };
    this.bindings.set(key, rec);
    return { ...rec };
  }

  async deleteBinding(workspaceId: string, projectId: string, workerId: string): Promise<boolean> {
    const key = InMemoryProjectsRepository.bindingKey(projectId, workerId);
    const b = this.bindings.get(key);
    if (!b || b.workspaceId !== workspaceId) return false;
    this.bindings.delete(key);
    return true;
  }
}

interface HasKey {
  id: string;
  updatedAt: Date;
}

function compareByUpdatedDesc(a: HasKey, b: HasKey): number {
  const dt = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id DESC tiebreak
}

function paginate<T extends HasKey>(sorted: T[], page: PageQuery): Page<T> {
  let start = 0;
  if (page.cursor) {
    const raw = Buffer.from(page.cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const cursorTime = new Date(iso).getTime();
    start = sorted.findIndex((r) => {
      const t = r.updatedAt.getTime();
      return t < cursorTime || (t === cursorTime && r.id < id);
    });
    if (start < 0) start = sorted.length;
  }
  const slice = sorted.slice(start, start + page.limit);
  const last = slice[slice.length - 1];
  const more = start + page.limit < sorted.length;
  return {
    items: slice.map((r) => ({ ...r })),
    nextCursor: more && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
  };
}

/**
 * DB-backed {@link ProjectsRepository} over `@redai/db`. This is the production
 * adapter (the service unit tests use the in-memory fake instead). It owns its SQL:
 * every statement carries an explicit `workspace_id` predicate, and every
 * project-level statement also carries `project_id`, so a request scoped to project
 * A can never read or write project B (INV-001). The composite `(id, project_id,
 * workspace_id)` unique keys back this up at the schema level.
 *
 * Optimistic concurrency (docs/05 §1): metadata updates carry the caller's
 * `expected_revision` in the WHERE clause and bump `revision` in the same statement,
 * so a stale write updates zero rows and is reported as a conflict.
 */
import { ACTIVE_RUN_STATES, withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
import { encodeCursor } from './cursor.js';
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

const FK_VIOLATION = '23503';

function isFkViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === FK_VIOLATION
  );
}

// --- row shapes (snake_case, as returned by pg) ---

interface ProjectDbRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  is_inbox: boolean;
  approval_mode: ProjectRecord['approvalMode'];
  data_mode: ProjectRecord['dataMode'];
  revision: string;
  created_at: Date;
  updated_at: Date;
}

interface ChatDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  pinned: boolean;
  revision: string;
  message_seq: string;
  created_at: Date;
  updated_at: Date;
}

interface NoteDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  content: string;
  selected_for_context: boolean;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

interface BindingDbRow {
  workspace_id: string;
  project_id: string;
  worker_id: string;
  zone: string;
  enabled: boolean;
  created_at: Date;
}

function toProject(r: ProjectDbRow): ProjectRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    status: r.status,
    isInbox: r.is_inbox,
    approvalMode: r.approval_mode,
    dataMode: r.data_mode,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toChat(r: ChatDbRow): ChatRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    title: r.title,
    pinned: r.pinned,
    revision: r.revision,
    messageSeq: r.message_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toNote(r: NoteDbRow): NoteRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    title: r.title,
    content: r.content,
    selectedForContext: r.selected_for_context,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toBinding(r: BindingDbRow): BindingRecord {
  return {
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    workerId: r.worker_id,
    zone: r.zone,
    enabled: r.enabled,
    createdAt: r.created_at,
  };
}

/** Keyset page over rows already ordered `updated_at DESC, id DESC`, fetched limit+1. */
function toPage<
  Row extends { id: string; updated_at: Date },
  Rec extends { id: string; updatedAt: Date },
>(rows: Row[], limit: number, map: (r: Row) => Rec): Page<Rec> {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(map);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
  };
}

interface CursorParts {
  time: Date;
  id: string;
}

function decodeCursorParts(cursor: string | undefined): CursorParts | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const time = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(time.getTime()) || id === '') return null;
    return { time, id };
  } catch {
    return null;
  }
}

export function createDbProjectsRepository(pool: Pool): ProjectsRepository {
  const exec: Executor = pool;

  return {
    // -------------------------------------------------------------- projects

    async createProject(workspaceId, id, fields: CreateProjectFields): Promise<ProjectRecord> {
      const res = await exec.query<ProjectDbRow>(
        `INSERT INTO projects (id, workspace_id, name, description, approval_mode, data_mode)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          id,
          workspaceId,
          fields.name,
          fields.description ?? '',
          fields.approvalMode ?? 'automatic',
          fields.dataMode ?? 'redacted_cloud',
        ],
      );
      return toProject(res.rows[0]!);
    },

    async getProject(workspaceId, projectId): Promise<ProjectRecord | null> {
      const res = await exec.query<ProjectDbRow>(
        'SELECT * FROM projects WHERE id = $1 AND workspace_id = $2',
        [projectId, workspaceId],
      );
      return res.rows[0] ? toProject(res.rows[0]) : null;
    },

    async getInbox(workspaceId): Promise<ProjectRecord | null> {
      const res = await exec.query<ProjectDbRow>(
        'SELECT * FROM projects WHERE workspace_id = $1 AND is_inbox = true',
        [workspaceId],
      );
      return res.rows[0] ? toProject(res.rows[0]) : null;
    },

    async listProjects(workspaceId, page: PageQuery): Promise<Page<ProjectRecord>> {
      const cur = decodeCursorParts(page.cursor);
      // The cursor timestamp is millisecond-precision (JS Date / ISO 8601), while the
      // `updated_at` column is microsecond-precision. Truncate the column to
      // milliseconds in BOTH the order key and the seek so the keyset is exact and
      // equal-millisecond rows are never skipped.
      const rows = cur
        ? await exec.query<ProjectDbRow>(
            `SELECT * FROM projects
             WHERE workspace_id = $1 AND status <> 'deleted'
               AND (date_trunc('milliseconds', updated_at), id) < ($2::timestamptz, $3::uuid)
             ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC LIMIT $4`,
            [workspaceId, cur.time, cur.id, page.limit + 1],
          )
        : await exec.query<ProjectDbRow>(
            `SELECT * FROM projects
             WHERE workspace_id = $1 AND status <> 'deleted'
             ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC LIMIT $2`,
            [workspaceId, page.limit + 1],
          );
      return toPage(rows.rows, page.limit, toProject);
    },

    async updateProject(
      workspaceId,
      projectId,
      expectedRevision,
      fields: UpdateProjectFields,
    ): Promise<ProjectRecord | 'not-found' | 'conflict'> {
      const res = await exec.query<ProjectDbRow>(
        `UPDATE projects SET
           name = COALESCE($4, name),
           description = COALESCE($5, description),
           approval_mode = COALESCE($6, approval_mode),
           data_mode = COALESCE($7, data_mode),
           revision = revision + 1,
           updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND revision = $3
         RETURNING *`,
        [
          projectId,
          workspaceId,
          expectedRevision,
          fields.name ?? null,
          fields.description ?? null,
          fields.approvalMode ?? null,
          fields.dataMode ?? null,
        ],
      );
      if (res.rows[0]) return toProject(res.rows[0]);
      return classifyMiss(await projectExists(exec, workspaceId, projectId));
    },

    async setProjectStatus(
      workspaceId,
      projectId,
      from: readonly ProjectStatus[],
      to: ProjectStatus,
    ): Promise<ProjectRecord | 'not-found'> {
      const res = await exec.query<ProjectDbRow>(
        `UPDATE projects SET status = $4, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND status = ANY($3::text[])
         RETURNING *`,
        [projectId, workspaceId, [...from], to],
      );
      return res.rows[0] ? toProject(res.rows[0]) : 'not-found';
    },

    async countActiveRunsForProject(workspaceId, projectId): Promise<number> {
      const res = await exec.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM runs
         WHERE workspace_id = $1 AND project_id = $2 AND state = ANY($3::text[])`,
        [workspaceId, projectId, [...ACTIVE_RUN_STATES]],
      );
      return Number(res.rows[0]?.n ?? '0');
    },

    // ----------------------------------------------------------------- chats

    async createChat(workspaceId, projectId, id, fields: CreateChatFields): Promise<ChatRecord> {
      const res = await exec.query<ChatDbRow>(
        `INSERT INTO chats (id, workspace_id, project_id, title, pinned)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, workspaceId, projectId, fields.title ?? '', fields.pinned ?? false],
      );
      return toChat(res.rows[0]!);
    },

    async getChat(workspaceId, projectId, chatId): Promise<ChatRecord | null> {
      const res = await exec.query<ChatDbRow>(
        'SELECT * FROM chats WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [chatId, projectId, workspaceId],
      );
      return res.rows[0] ? toChat(res.rows[0]) : null;
    },

    async listChats(workspaceId, projectId, page: PageQuery): Promise<Page<ChatRecord>> {
      const cur = decodeCursorParts(page.cursor);
      const rows = cur
        ? await exec.query<ChatDbRow>(
            `SELECT * FROM chats
             WHERE workspace_id = $1 AND project_id = $2
               AND (date_trunc('milliseconds', updated_at), id) < ($3::timestamptz, $4::uuid)
             ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC LIMIT $5`,
            [workspaceId, projectId, cur.time, cur.id, page.limit + 1],
          )
        : await exec.query<ChatDbRow>(
            `SELECT * FROM chats
             WHERE workspace_id = $1 AND project_id = $2
             ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC LIMIT $3`,
            [workspaceId, projectId, page.limit + 1],
          );
      return toPage(rows.rows, page.limit, toChat);
    },

    async updateChat(
      workspaceId,
      projectId,
      chatId,
      expectedRevision,
      fields: UpdateChatFields,
    ): Promise<ChatRecord | 'not-found' | 'conflict'> {
      const res = await exec.query<ChatDbRow>(
        `UPDATE chats SET
           title = COALESCE($5, title),
           pinned = COALESCE($6, pinned),
           revision = revision + 1,
           updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND revision = $4
         RETURNING *`,
        [
          chatId,
          projectId,
          workspaceId,
          expectedRevision,
          fields.title ?? null,
          fields.pinned ?? null,
        ],
      );
      if (res.rows[0]) return toChat(res.rows[0]);
      return classifyMiss(await chatExists(exec, workspaceId, projectId, chatId));
    },

    async deleteChat(workspaceId, projectId, chatId): Promise<boolean> {
      const res = await exec.query(
        'DELETE FROM chats WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [chatId, projectId, workspaceId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async countActiveRunsForChat(workspaceId, projectId, chatId): Promise<number> {
      const res = await exec.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM runs
         WHERE workspace_id = $1 AND project_id = $2 AND chat_id = $3 AND state = ANY($4::text[])`,
        [workspaceId, projectId, chatId, [...ACTIVE_RUN_STATES]],
      );
      return Number(res.rows[0]?.n ?? '0');
    },

    // ----------------------------------------------------------------- notes

    async createNote(workspaceId, projectId, id, fields: CreateNoteFields): Promise<NoteRecord> {
      const res = await exec.query<NoteDbRow>(
        `INSERT INTO notes (id, workspace_id, project_id, title, content, selected_for_context)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          id,
          workspaceId,
          projectId,
          fields.title,
          fields.content,
          fields.selectedForContext ?? true,
        ],
      );
      return toNote(res.rows[0]!);
    },

    async getNote(workspaceId, projectId, noteId): Promise<NoteRecord | null> {
      const res = await exec.query<NoteDbRow>(
        'SELECT * FROM notes WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [noteId, projectId, workspaceId],
      );
      return res.rows[0] ? toNote(res.rows[0]) : null;
    },

    async listNotes(
      workspaceId,
      projectId,
      opts: { selectedOnly?: boolean | undefined },
    ): Promise<NoteRecord[]> {
      const res = opts.selectedOnly
        ? await exec.query<NoteDbRow>(
            `SELECT * FROM notes
             WHERE workspace_id = $1 AND project_id = $2 AND selected_for_context = true
             ORDER BY updated_at DESC, id DESC`,
            [workspaceId, projectId],
          )
        : await exec.query<NoteDbRow>(
            `SELECT * FROM notes
             WHERE workspace_id = $1 AND project_id = $2
             ORDER BY updated_at DESC, id DESC`,
            [workspaceId, projectId],
          );
      return res.rows.map(toNote);
    },

    async updateNote(
      workspaceId,
      projectId,
      noteId,
      expectedRevision,
      fields: UpdateNoteFields,
    ): Promise<NoteRecord | 'not-found' | 'conflict'> {
      const res = await exec.query<NoteDbRow>(
        `UPDATE notes SET
           title = COALESCE($5, title),
           content = COALESCE($6, content),
           selected_for_context = COALESCE($7, selected_for_context),
           revision = revision + 1,
           updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND revision = $4
         RETURNING *`,
        [
          noteId,
          projectId,
          workspaceId,
          expectedRevision,
          fields.title ?? null,
          fields.content ?? null,
          fields.selectedForContext ?? null,
        ],
      );
      if (res.rows[0]) return toNote(res.rows[0]);
      return classifyMiss(await noteExists(exec, workspaceId, projectId, noteId));
    },

    async deleteNote(workspaceId, projectId, noteId): Promise<boolean> {
      const res = await exec.query(
        'DELETE FROM notes WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [noteId, projectId, workspaceId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    // -------------------------------------------------------------- bindings

    async listBindings(workspaceId, projectId): Promise<BindingRecord[]> {
      const res = await exec.query<BindingDbRow>(
        `SELECT * FROM project_workers
         WHERE workspace_id = $1 AND project_id = $2
         ORDER BY worker_id ASC`,
        [workspaceId, projectId],
      );
      return res.rows.map(toBinding);
    },

    async upsertBinding(
      workspaceId,
      projectId,
      workerId,
      fields: UpsertBindingFields,
    ): Promise<BindingRecord | 'worker-not-found'> {
      try {
        // Both the project FK and the (worker_id, zone, workspace_id) worker FK must
        // hold; a bad worker/zone raises 23503, mapped to a typed not-found.
        return await withTransaction(pool, async (tx) => {
          const res = await tx.query<BindingDbRow>(
            `INSERT INTO project_workers (workspace_id, project_id, worker_id, zone, enabled)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (project_id, worker_id)
             DO UPDATE SET zone = EXCLUDED.zone, enabled = EXCLUDED.enabled
             RETURNING *`,
            [workspaceId, projectId, workerId, fields.zone, fields.enabled ?? true],
          );
          return toBinding(res.rows[0]!);
        });
      } catch (err) {
        if (isFkViolation(err)) return 'worker-not-found';
        throw err;
      }
    },

    async deleteBinding(workspaceId, projectId, workerId): Promise<boolean> {
      const res = await exec.query(
        'DELETE FROM project_workers WHERE workspace_id = $1 AND project_id = $2 AND worker_id = $3',
        [workspaceId, projectId, workerId],
      );
      return (res.rowCount ?? 0) > 0;
    },
  };
}

function classifyMiss(exists: boolean): 'not-found' | 'conflict' {
  // The row exists (composite key matched) but the revision predicate failed → a
  // concurrent edit won. It does not exist → the caller addressed a foreign/unknown id.
  return exists ? 'conflict' : 'not-found';
}

async function projectExists(
  exec: Executor,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  const res = await exec.query('SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2', [
    projectId,
    workspaceId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

async function chatExists(
  exec: Executor,
  workspaceId: string,
  projectId: string,
  chatId: string,
): Promise<boolean> {
  const res = await exec.query(
    'SELECT 1 FROM chats WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
    [chatId, projectId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

async function noteExists(
  exec: Executor,
  workspaceId: string,
  projectId: string,
  noteId: string,
): Promise<boolean> {
  const res = await exec.query(
    'SELECT 1 FROM notes WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
    [noteId, projectId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

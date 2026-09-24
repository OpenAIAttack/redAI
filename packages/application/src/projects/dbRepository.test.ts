/**
 * Live-PostgreSQL integration tests for the DB-backed projects repository + service.
 * These prove the SQL enforces the invariants the in-memory fake only simulates:
 * cross-project isolation via the composite `(id, project_id, workspace_id)` keys,
 * the Inbox partial-unique, revision optimistic concurrency, note selection, the
 * binding worker FK, and the active-run delete guard.
 *
 * Self-contained throwaway-database harness (mirrors the T02
 * `tests/integration/db/support.ts` pattern) built only on the `@redai/db` package
 * export, so this file stays within the application package's `rootDir`. Each suite
 * gets a fresh migrated database and drops it afterwards. Skips LOUDLY when
 * DATABASE_URL is unset. Start the throwaway PostgreSQL cluster and export
 * DATABASE_URL (see release-evidence/T06) before running the DB-backed suite.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@redai/db';
import type { Pool } from '@redai/db';
import { createDbProjectsRepository } from './dbRepository.js';
import { ProjectsService } from './service.js';
import {
  ChatHasActiveRunError,
  ChatNotFoundError,
  InboxProtectedError,
  NoteNotFoundError,
  ProjectHasActiveRunError,
  RevisionConflictError,
  WorkerNotFoundError,
} from './errors.js';
import type { Clock, RandomSource } from './ports.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;
if (!HAS_DB) {
  console.warn(
    '\n[T06] DATABASE_URL is not set — the live-PostgreSQL projects suite is SKIPPED.\n' +
      '      Start a throwaway PG16 cluster and export DATABASE_URL, e.g.:\n' +
      '        export PGDATA=$PWD/.tmp-pg/t06 PGPORT=55462\n' +
      '        initdb -D "$PGDATA" -U redai --auth=trust\n' +
      '        pg_ctl -D "$PGDATA" -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -w start\n' +
      '        export DATABASE_URL="postgres://redai@127.0.0.1:$PGPORT/postgres"\n',
  );
}

const describeDb = HAS_DB ? describe : describe.skip;

interface TestDatabase {
  pool: Pool;
  drop: () => Promise<void>;
}

/** Create a fresh migrated database on the cluster named by DATABASE_URL. */
async function createTestDatabase(): Promise<TestDatabase> {
  if (!HAS_DB || !DATABASE_URL) throw new Error('createTestDatabase called without DATABASE_URL');
  const name = `redai_t06_${randomBytes(6).toString('hex')}`;
  const admin = createPool({
    connectionString: DATABASE_URL,
    max: 1,
    applicationName: 'redai-t06-admin',
  });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({
    connectionString: url.toString(),
    max: 8,
    applicationName: `redai-t06-${name}`,
  });
  await migrate(pool);
  const drop = async (): Promise<void> => {
    await pool.end().catch(() => {});
    const dropAdmin = createPool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await dropAdmin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await dropAdmin.end();
    }
  };
  return { pool, drop };
}

class FixedClock implements Clock {
  now(): Date {
    return new Date(1_700_000_000_000);
  }
}
class SeqUuid implements RandomSource {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `10000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

async function makeWorkspace(
  pool: Pool,
  inboxName = 'Inbox',
): Promise<{ workspaceId: string; inboxId: string }> {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name, installation_id) VALUES ('redAI', gen_random_uuid()) RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;
  const inbox = await pool.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, name, is_inbox) VALUES ($1, $2, true) RETURNING id`,
    [workspaceId, inboxName],
  );
  return { workspaceId, inboxId: inbox.rows[0]!.id };
}

/** Insert a worker row directly (T15 owns worker identity; this is only a FK fixture). */
async function insertWorker(pool: Pool, workspaceId: string, zone = 'lab'): Promise<string> {
  const w = await pool.query<{ id: string }>(
    `INSERT INTO workers (workspace_id, display_name, zone, agent_version, manifest_sha256)
     VALUES ($1, 'w', $2, '1.0.0', 'sha') RETURNING id`,
    [workspaceId, zone],
  );
  return w.rows[0]!.id;
}

/** Insert a run in an active state for the delete-guard tests. */
async function insertActiveRun(
  pool: Pool,
  workspaceId: string,
  projectId: string,
  chatId: string,
): Promise<void> {
  const pc = await pool.query<{ id: string }>(
    `INSERT INTO provider_configs (workspace_id, display_name, config) VALUES ($1, 'pc', '{}'::jsonb) RETURNING id`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO runs (workspace_id, project_id, chat_id, mode, state, provider_config_id, config_snapshot, budget_limit_micro_usd, expires_at)
     VALUES ($1, $2, $3, 'agent', 'running', $4, '{}'::jsonb, 1000, now() + interval '1 hour')`,
    [workspaceId, projectId, chatId, pc.rows[0]!.id],
  );
}

describeDb('DB projects repository (live PostgreSQL)', () => {
  let db: TestDatabase;
  let svc: ProjectsService;

  beforeEach(async () => {
    db = await createTestDatabase();
    svc = new ProjectsService({
      repo: createDbProjectsRepository(db.pool),
      clock: new FixedClock(),
      random: new SeqUuid(),
    });
  });
  afterEach(async () => {
    await db.drop();
  });

  it('HEADLINE: swapping a chat/note UUID from another project is rejected by the composite key', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const a = await svc.createProject(workspaceId, { name: 'A' });
    const b = await svc.createProject(workspaceId, { name: 'B' });
    const chatB = await svc.createChat(workspaceId, b.id, { title: 'B chat' });
    const noteB = await svc.createNote(workspaceId, b.id, { title: 'B', content: 'secret' });

    await expect(svc.getChat(workspaceId, a.id, chatB.id)).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(svc.getNote(workspaceId, a.id, noteB.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    await expect(
      svc.updateChat(workspaceId, a.id, chatB.id, '1', { title: 'x' }),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(svc.deleteNote(workspaceId, a.id, noteB.id)).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );

    // The rows are untouched and still reachable under their real project.
    expect((await svc.getChat(workspaceId, b.id, chatB.id)).id).toBe(chatB.id);
    expect((await svc.getNote(workspaceId, b.id, noteB.id)).content).toBe('secret');
  });

  it('a project is invisible under a different workspace_id (workspace predicate)', async () => {
    // `workspaces` is a per-install singleton, so isolation is proven by querying an
    // existing project under a foreign workspace_id: the predicate makes it vanish.
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'Owned' });
    const foreignWorkspace = '88888888-8888-4888-8888-888888888888';
    expect(await createDbProjectsRepository(db.pool).getProject(foreignWorkspace, p.id)).toBeNull();
    // And it is reachable under its real workspace.
    expect((await svc.getProject(workspaceId, p.id)).id).toBe(p.id);
  });

  it('the Inbox partial-unique blocks a second inbox and the Inbox cannot be archived', async () => {
    const { workspaceId, inboxId } = await makeWorkspace(db.pool);
    await expect(
      db.pool.query(
        `INSERT INTO projects (workspace_id, name, is_inbox) VALUES ($1, 'Inbox2', true)`,
        [workspaceId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Inbox is protected from archive.
    await expect(svc.archiveProject(workspaceId, inboxId)).rejects.toBeInstanceOf(
      InboxProtectedError,
    );
  });

  it('archive preserves rows (chats/notes survive) and flips status only', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'Keep' });
    const chat = await svc.createChat(workspaceId, p.id, { title: 'c' });
    const note = await svc.createNote(workspaceId, p.id, { title: 'n', content: 'v' });

    const archived = await svc.archiveProject(workspaceId, p.id);
    expect(archived.status).toBe('archived');

    // All child rows remain in the database after archive.
    expect((await svc.getChat(workspaceId, p.id, chat.id)).id).toBe(chat.id);
    expect((await svc.getNote(workspaceId, p.id, note.id)).id).toBe(note.id);
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM chats WHERE project_id = $1`, [
      p.id,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('optimistic concurrency: a stale note update is a REVISION_CONFLICT (409-mapped)', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'P' });
    const note = await svc.createNote(workspaceId, p.id, { title: 'N', content: 'x' });
    const first = await svc.updateNote(workspaceId, p.id, note.id, '1', { content: 'y' });
    expect(first.revision).toBe('2');
    await expect(
      svc.updateNote(workspaceId, p.id, note.id, '1', { content: 'z' }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('optimistic concurrency: two concurrent chat renames — exactly one wins', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'P' });
    const chat = await svc.createChat(workspaceId, p.id, { title: 'orig' });
    const repo = createDbProjectsRepository(db.pool);
    const [r1, r2] = await Promise.all([
      repo.updateChat(workspaceId, p.id, chat.id, '1', { title: 'A' }),
      repo.updateChat(workspaceId, p.id, chat.id, '1', { title: 'B' }),
    ]);
    const outcomes = [r1, r2];
    expect(outcomes.filter((r) => r === 'conflict')).toHaveLength(1);
    expect(outcomes.filter((r) => typeof r === 'object')).toHaveLength(1);
  });

  it('selected_for_context drives the context read (what a context builder queries)', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'P' });
    const included = await svc.createNote(workspaceId, p.id, { title: 'in', content: 'x' });
    await svc.createNote(workspaceId, p.id, {
      title: 'out',
      content: 'y',
      selectedForContext: false,
    });

    let ctx = await svc.listSelectedNotesForContext(workspaceId, p.id);
    expect(ctx.map((n) => n.id)).toEqual([included.id]);

    await svc.updateNote(workspaceId, p.id, included.id, '1', { selectedForContext: false });
    ctx = await svc.listSelectedNotesForContext(workspaceId, p.id);
    expect(ctx).toHaveLength(0);
  });

  it('worker binding: known worker binds; unknown worker/zone is a typed WorkerNotFound (FK)', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'P' });
    const workerId = await insertWorker(db.pool, workspaceId, 'lab');

    const binding = await svc.upsertBinding(workspaceId, p.id, workerId, {
      zone: 'lab',
      enabled: true,
    });
    expect(binding.enabled).toBe(true);
    // Idempotent upsert updates config in place.
    const updated = await svc.upsertBinding(workspaceId, p.id, workerId, {
      zone: 'lab',
      enabled: false,
    });
    expect(updated.enabled).toBe(false);
    expect((await svc.listBindings(workspaceId, p.id)).length).toBe(1);

    // Wrong zone → worker FK unsatisfied → typed not-found (never a 500).
    await expect(
      svc.upsertBinding(workspaceId, p.id, workerId, { zone: 'nope' }),
    ).rejects.toBeInstanceOf(WorkerNotFoundError);
    // Unknown worker id.
    await expect(
      svc.upsertBinding(workspaceId, p.id, '99999999-9999-4999-8999-999999999999', { zone: 'lab' }),
    ).rejects.toBeInstanceOf(WorkerNotFoundError);
  });

  it('delete is blocked while an active run exists on the project/chat', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const p = await svc.createProject(workspaceId, { name: 'Busy' });
    const chat = await svc.createChat(workspaceId, p.id, { title: 'c' });
    await insertActiveRun(db.pool, workspaceId, p.id, chat.id);

    await expect(
      svc.deleteProject(workspaceId, p.id, { confirmName: 'Busy' }),
    ).rejects.toBeInstanceOf(ProjectHasActiveRunError);
    await expect(svc.deleteChat(workspaceId, p.id, chat.id)).rejects.toBeInstanceOf(
      ChatHasActiveRunError,
    );
  });

  it('keyset pagination returns stable, non-overlapping pages ordered by updated_at desc', async () => {
    const { workspaceId } = await makeWorkspace(db.pool);
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push((await svc.createProject(workspaceId, { name: `P${i}` })).id);
    }
    const page1 = await svc.listProjects(workspaceId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.listProjects(workspaceId, { limit: 2, cursor: page1.nextCursor! });
    const page3 = await svc.listProjects(workspaceId, { limit: 2, cursor: page2.nextCursor! });
    const seen = [...page1.items, ...page2.items, ...page3.items].map((p) => p.id);
    // 5 projects + the Inbox = 6 rows across the three pages, no duplicates.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6);
  });
});

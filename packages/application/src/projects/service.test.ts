/**
 * Unit tests for {@link ProjectsService} over the in-memory repository. These prove
 * the use-case logic (cross-project isolation, Inbox protection, optimistic
 * concurrency, note selection, active-run guards, pagination shape) fast and without
 * a database. The DB adapter's own suite (`dbRepository.test.ts`) proves the SQL
 * enforces the same invariants against live PostgreSQL.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectsRepository } from './memoryRepository.js';
import { ProjectsService } from './service.js';
import {
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
import type { Clock, RandomSource } from './ports.js';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

class FixedClock implements Clock {
  public constructor(private ms = 1_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
}

class SeqUuid implements RandomSource {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

function makeService(): { svc: ProjectsService; repo: InMemoryProjectsRepository } {
  const repo = new InMemoryProjectsRepository(new FixedClock());
  const svc = new ProjectsService({ repo, clock: new FixedClock(), random: new SeqUuid() });
  return { svc, repo };
}

describe('ProjectsService — projects & Inbox', () => {
  let svc: ProjectsService;
  let repo: InMemoryProjectsRepository;
  beforeEach(() => {
    ({ svc, repo } = makeService());
  });

  it('creates a project with defaults and reads it back', async () => {
    const p = await svc.createProject(WS_A, { name: 'Recon' });
    expect(p.status).toBe('active');
    expect(p.isInbox).toBe(false);
    expect(p.approvalMode).toBe('automatic');
    expect(p.revision).toBe('1');
    const got = await svc.getProject(WS_A, p.id);
    expect(got.id).toBe(p.id);
  });

  it('getInbox returns the singleton system project', async () => {
    await repo.createInbox(WS_A, 'aaaaaaaa-0000-4000-8000-000000000001');
    const inbox = await svc.getInbox(WS_A);
    expect(inbox.isInbox).toBe(true);
  });

  it('enforces the Inbox singleton (a second Inbox is rejected)', async () => {
    await repo.createInbox(WS_A, 'aaaaaaaa-0000-4000-8000-000000000001');
    await expect(repo.createInbox(WS_A, 'aaaaaaaa-0000-4000-8000-000000000002')).rejects.toThrow(
      /Inbox already exists/,
    );
  });

  it('archive keeps the row and flips status; the Inbox cannot be archived', async () => {
    const p = await svc.createProject(WS_A, { name: 'Keep me' });
    const archived = await svc.archiveProject(WS_A, p.id);
    expect(archived.status).toBe('archived');
    // Row still present and readable after archive (archive != delete).
    const still = await svc.getProject(WS_A, p.id);
    expect(still.status).toBe('archived');

    const inbox = await repo.createInbox(WS_A, 'aaaaaaaa-0000-4000-8000-000000000009');
    await expect(svc.archiveProject(WS_A, inbox.id)).rejects.toBeInstanceOf(InboxProtectedError);
  });

  it('delete requires the exact name, blocks the Inbox, and tombstones to deleting', async () => {
    const p = await svc.createProject(WS_A, { name: 'Danger Zone' });
    await expect(svc.deleteProject(WS_A, p.id, { confirmName: 'wrong' })).rejects.toBeInstanceOf(
      NameConfirmationMismatchError,
    );
    const del = await svc.deleteProject(WS_A, p.id, { confirmName: 'Danger Zone' });
    expect(del.status).toBe('deleting');
  });

  it('delete is blocked while an active run exists (INV-002)', async () => {
    const p = await svc.createProject(WS_A, { name: 'Busy' });
    repo.runs.push({ workspaceId: WS_A, projectId: p.id, chatId: 'c', active: true });
    await expect(svc.deleteProject(WS_A, p.id, { confirmName: 'Busy' })).rejects.toBeInstanceOf(
      ProjectHasActiveRunError,
    );
  });

  it('optimistic concurrency: a stale project update is a REVISION_CONFLICT', async () => {
    const p = await svc.createProject(WS_A, { name: 'Orig' });
    const updated = await svc.updateProject(WS_A, p.id, '1', { name: 'New' });
    expect(updated.revision).toBe('2');
    await expect(svc.updateProject(WS_A, p.id, '1', { name: 'Stale' })).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
  });

  it('list returns a { items, nextCursor } page and paginates deterministically', async () => {
    for (let i = 0; i < 5; i += 1) await svc.createProject(WS_A, { name: `P${i}` });
    const first = await svc.listProjects(WS_A, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await svc.listProjects(WS_A, { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    // No overlap between pages.
    const ids = new Set(first.items.map((p) => p.id));
    expect(second.items.every((p) => !ids.has(p.id))).toBe(true);
  });
});

describe('ProjectsService — cross-project isolation (headline)', () => {
  it('a chat/note UUID from project B is not reachable under project A', async () => {
    const { svc } = makeService();
    const a = await svc.createProject(WS_A, { name: 'A' });
    const b = await svc.createProject(WS_A, { name: 'B' });
    const chatB = await svc.createChat(WS_A, b.id, { title: 'secret B chat' });
    const noteB = await svc.createNote(WS_A, b.id, { title: 'B', content: 'secret' });

    // Swapping in B's ids under project A resolves to NotFound, never a cross read.
    await expect(svc.getChat(WS_A, a.id, chatB.id)).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(svc.getNote(WS_A, a.id, noteB.id)).rejects.toBeInstanceOf(NoteNotFoundError);
    // Writes are equally rejected.
    await expect(svc.updateChat(WS_A, a.id, chatB.id, '1', { title: 'x' })).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(svc.deleteNote(WS_A, a.id, noteB.id)).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it('a project from another workspace is not reachable', async () => {
    const { svc } = makeService();
    const pB = await svc.createProject(WS_B, { name: 'B-owned' });
    await expect(svc.getProject(WS_A, pB.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('ProjectsService — chats', () => {
  it('cannot create a chat under an archived project', async () => {
    const { svc } = makeService();
    const p = await svc.createProject(WS_A, { name: 'P' });
    await svc.archiveProject(WS_A, p.id);
    await expect(svc.createChat(WS_A, p.id, {})).rejects.toBeInstanceOf(ProjectNotActiveError);
  });

  it('optimistic concurrency on chat rename', async () => {
    const { svc } = makeService();
    const p = await svc.createProject(WS_A, { name: 'P' });
    const c = await svc.createChat(WS_A, p.id, { title: 'orig' });
    const r = await svc.updateChat(WS_A, p.id, c.id, '1', { title: 'renamed', pinned: true });
    expect(r.title).toBe('renamed');
    expect(r.pinned).toBe(true);
    expect(r.revision).toBe('2');
    await expect(svc.updateChat(WS_A, p.id, c.id, '1', { title: 'stale' })).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
  });

  it('cannot delete a chat with an active run', async () => {
    const { svc, repo } = makeService();
    const p = await svc.createProject(WS_A, { name: 'P' });
    const c = await svc.createChat(WS_A, p.id, {});
    repo.runs.push({ workspaceId: WS_A, projectId: p.id, chatId: c.id, active: true });
    await expect(svc.deleteChat(WS_A, p.id, c.id)).rejects.toBeInstanceOf(ChatHasActiveRunError);
  });
});

describe('ProjectsService — notes & selected_for_context', () => {
  it('toggles selected_for_context and that drives the context read', async () => {
    const { svc } = makeService();
    const p = await svc.createProject(WS_A, { name: 'P' });
    const included = await svc.createNote(WS_A, p.id, { title: 'in', content: 'x' });
    const excluded = await svc.createNote(WS_A, p.id, {
      title: 'out',
      content: 'y',
      selectedForContext: false,
    });
    expect(included.selectedForContext).toBe(true);

    let ctx = await svc.listSelectedNotesForContext(WS_A, p.id);
    expect(ctx.map((n) => n.id)).toEqual([included.id]);

    // Flip: include the excluded one, drop the included one.
    await svc.updateNote(WS_A, p.id, excluded.id, '1', { selectedForContext: true });
    await svc.updateNote(WS_A, p.id, included.id, '1', { selectedForContext: false });
    ctx = await svc.listSelectedNotesForContext(WS_A, p.id);
    expect(ctx.map((n) => n.id).sort()).toEqual([excluded.id]);
  });
});

describe('ProjectsService — worker bindings', () => {
  it('binds a known worker and rejects an unknown worker/zone', async () => {
    const { svc, repo } = makeService();
    const p = await svc.createProject(WS_A, { name: 'P' });
    const workerId = '33333333-3333-4333-8333-333333333333';
    repo.workers.push({ workspaceId: WS_A, workerId, zone: 'lab' });

    const binding = await svc.upsertBinding(WS_A, p.id, workerId, { zone: 'lab', enabled: true });
    expect(binding.enabled).toBe(true);
    expect(binding.zone).toBe('lab');

    // Re-bind updates config in place (idempotent upsert).
    const updated = await svc.upsertBinding(WS_A, p.id, workerId, { zone: 'lab', enabled: false });
    expect(updated.enabled).toBe(false);
    expect((await svc.listBindings(WS_A, p.id)).length).toBe(1);

    await expect(
      svc.upsertBinding(WS_A, p.id, '44444444-4444-4444-8444-444444444444', { zone: 'lab' }),
    ).rejects.toBeInstanceOf(WorkerNotFoundError);
  });
});

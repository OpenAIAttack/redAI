/**
 * API inject tests for the projects plugin. A bare Fastify instance mounts
 * `registerProjects` with an in-memory use-case service and a header-based fake owner
 * guard — no database, no server.ts. These prove: routes require the injected owner
 * auth (401), the pagination envelope shape, body validation (422), cross-project
 * isolation over HTTP (404), optimistic-concurrency conflict (409) and the mutation
 * guard (403).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryProjectsRepository,
  ProjectsService,
  type Clock,
  type RandomSource,
} from '@redai/application/projects';
import { registerProjects, type OwnerContext } from './plugin.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

class FixedClock implements Clock {
  now(): Date {
    return new Date(1_000_000);
  }
}
class SeqUuid implements RandomSource {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

interface Harness {
  app: FastifyInstance;
  repo: InMemoryProjectsRepository;
}

async function setup(opts: { authorizeMutation?: boolean } = {}): Promise<Harness> {
  const repo = new InMemoryProjectsRepository(new FixedClock());
  const service = new ProjectsService({ repo, clock: new FixedClock(), random: new SeqUuid() });
  const app = Fastify({ logger: false });
  registerProjects(app, {
    service,
    // Fake owner guard: authenticated iff the test header names the workspace.
    authenticate: (req) => {
      const ws = req.headers['x-test-workspace'];
      return Promise.resolve(
        typeof ws === 'string' && ws !== ''
          ? ({ workspaceId: ws, ownerId: 'owner' } as OwnerContext)
          : null,
      );
    },
    authorizeMutation: () => opts.authorizeMutation ?? true,
  });
  await app.ready();
  return { app, repo };
}

const auth = { 'x-test-workspace': WS, 'content-type': 'application/json' };

describe('projects plugin — auth', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unauthenticated mutation with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a mutation that fails the Origin/CSRF guard with 403', async () => {
    const blocked = await setup({ authorizeMutation: false });
    const res = await blocked.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
  });
});

describe('projects plugin — CRUD + pagination shape', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('creates a project (201) and lists it in a { items, next_cursor } envelope', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { name: 'Recon' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().is_inbox).toBe(false);
    expect(created.json().revision).toBe('1');

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body).toHaveProperty('next_cursor');
  });

  it('empty project list is an empty array, not an error', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([]);
    expect(list.json().next_cursor).toBeNull();
  });

  it('paginates with a cursor across two pages without overlap', async () => {
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: auth,
        payload: { name: `P${i}` },
      });
    }
    const p1 = (
      await h.app.inject({ method: 'GET', url: '/api/v1/projects?limit=2', headers: auth })
    ).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = (
      await h.app.inject({
        method: 'GET',
        url: `/api/v1/projects?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`,
        headers: auth,
      })
    ).json();
    expect(p2.items).toHaveLength(1);
    const firstIds = new Set(p1.items.map((p: { id: string }) => p.id));
    expect(p2.items.every((p: { id: string }) => !firstIds.has(p.id))).toBe(true);
  });

  it('rejects an invalid create body with 422', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: auth,
      payload: { name: '', extra: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('unknown project id → 404', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-4000-8000-0000000000ff',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('projects plugin — cross-project isolation over HTTP', () => {
  it("a note created under project B is 404 under project A's URL", async () => {
    const h = await setup();
    const a = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: auth,
        payload: { name: 'A' },
      })
    ).json();
    const b = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: auth,
        payload: { name: 'B' },
      })
    ).json();
    const note = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${b.id}/notes`,
        headers: auth,
        payload: { title: 'B-secret', content: 'x' },
      })
    ).json();

    const foreign = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${a.id}/notes/${note.id}`,
      headers: auth,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('NOTE_NOT_FOUND');

    // Correct project resolves it.
    const own = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${b.id}/notes/${note.id}`,
      headers: auth,
    });
    expect(own.statusCode).toBe(200);
  });
});

describe('projects plugin — optimistic concurrency', () => {
  it('a stale note update returns 409 REVISION_CONFLICT with revisions in details', async () => {
    const h = await setup();
    const p = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: auth,
        payload: { name: 'P' },
      })
    ).json();
    const note = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${p.id}/notes`,
        headers: auth,
        payload: { title: 'N', content: 'x' },
      })
    ).json();
    // First update wins (revision 1 → 2).
    const first = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${p.id}/notes/${note.id}`,
      headers: auth,
      payload: { expected_revision: 1, selected_for_context: false },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().selected_for_context).toBe(false);
    // Second update with the stale revision loses.
    const stale = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${p.id}/notes/${note.id}`,
      headers: auth,
      payload: { expected_revision: 1, content: 'y' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('REVISION_CONFLICT');
    expect(stale.json().error.details.current_revision).toBe('2');
  });
});

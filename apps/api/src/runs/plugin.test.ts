/**
 * API inject tests for the runs plugin. A bare Fastify instance mounts `registerRuns`
 * with a DB-neutral in-memory use-case service and a header-based fake owner guard —
 * no database, no server.ts, no model provider (the API never steps a run). These
 * prove: owner auth (401) and the mutation guard (403); the Idempotency-Key contract
 * (required, UUID, replay on repeat, 409 on a reused key with a different body, and
 * exactly-one-run under a double-submit); request-body validation via @redai/contracts
 * (422); the create/status/history response shapes; and cross-project isolation (404).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AskService,
  InMemoryMessagesRepository,
  type AskContextBuilder,
  type AskContextInputs,
  type ProviderResolver,
} from '@redai/application/messages';
import { registerRuns, type OwnerContext } from './plugin.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const CHAT = '00000000-0000-4000-8000-000000000003';
const PROVIDER = '00000000-0000-4000-8000-000000000004';
const CLIENT_MSG = '00000000-0000-4000-8000-0000000000aa';
const KEY = '00000000-0000-4000-8000-0000000000ff';

const emptyContext: AskContextBuilder = {
  async build(): Promise<AskContextInputs> {
    return { selectedNotes: [], attachedFiles: [], history: [] };
  },
};
const throwingResolver: ProviderResolver = {
  async resolve() {
    throw new Error('the API must never step a run');
  },
};

interface Harness {
  app: FastifyInstance;
  repo: InMemoryMessagesRepository;
}

async function setup(opts: { authorizeMutation?: boolean } = {}): Promise<Harness> {
  const repo = new InMemoryMessagesRepository();
  const service = new AskService({ repo, context: emptyContext, provider: throwingResolver });
  const app = Fastify({ logger: false });
  registerRuns(app, {
    service,
    authenticate: (req) => {
      const ws = req.headers['x-test-workspace'];
      return Promise.resolve(
        typeof ws === 'string' && ws !== ''
          ? ({ workspaceId: ws, ownerId: 'owner-1' } as OwnerContext)
          : null,
      );
    },
    authorizeMutation: () => opts.authorizeMutation ?? true,
  });
  await app.ready();
  return { app, repo };
}

const auth = { 'x-test-workspace': WS, 'content-type': 'application/json' };
const withKey = { ...auth, 'idempotency-key': KEY };

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chat_id: CHAT,
    client_message_id: CLIENT_MSG,
    text: 'What is redAI?',
    mode: 'ask',
    provider_config_id: PROVIDER,
    ...overrides,
  };
}

const createUrl = `/api/v1/projects/${PROJECT}/chats/${CHAT}/runs`;

describe('runs plugin — auth & mutation guard', () => {
  it('rejects an unauthenticated create with 401', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: createUrl,
      headers: { 'content-type': 'application/json', 'idempotency-key': KEY },
      payload: createBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a create failing the mutation guard with 403', async () => {
    const { app } = await setup({ authorizeMutation: false });
    const res = await app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('runs plugin — create Ask run', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('creates a run (201) and returns run + user message', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { run: Record<string, unknown>; message: Record<string, unknown> };
    expect(body.run['mode']).toBe('ask');
    expect(body.run['state']).toBe('queued');
    expect(body.run['chat_id']).toBe(CHAT);
    expect(body.message['role']).toBe('user');
    expect(body.message['text']).toBe('What is redAI?');
    expect(body.message['status']).toBe('completed');
  });

  it('requires an Idempotency-Key header (400)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: auth,
      payload: createBody(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects a non-UUID Idempotency-Key (400)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: { ...auth, 'idempotency-key': 'not-a-uuid' },
      payload: createBody(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('replays the same run for a repeated key + body (200)', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    const second = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const a = (first.json() as { run: { id: string } }).run.id;
    const b = (second.json() as { run: { id: string } }).run.id;
    expect(b).toBe(a);
    expect(h.repo._messagesForChat(CHAT).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('returns 409 for a reused key with a different body', async () => {
    await h.app.inject({ method: 'POST', url: createUrl, headers: withKey, payload: createBody() });
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody({ text: 'a different prompt' }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a double-submit (same key, concurrent) creates exactly one run', async () => {
    const [a, b] = await Promise.all([
      h.app.inject({ method: 'POST', url: createUrl, headers: withKey, payload: createBody() }),
      h.app.inject({ method: 'POST', url: createUrl, headers: withKey, payload: createBody() }),
    ]);
    const idA = (a.json() as { run: { id: string } }).run.id;
    const idB = (b.json() as { run: { id: string } }).run.id;
    expect(idA).toBe(idB);
    expect(h.repo._messagesForChat(CHAT).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('rejects a body whose chat_id does not match the path (422)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody({ chat_id: '00000000-0000-4000-8000-000000000099' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an agent-mode run with 501 (Ask only this milestone)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody({ mode: 'agent' }),
    });
    expect(res.statusCode).toBe(501);
  });

  it('rejects an invalid body (missing text) with 422', async () => {
    const bad = createBody();
    delete bad['text'];
    const res = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: bad,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('runs plugin — status & history', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('reads run status and paginated chat history', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    const runId = (created.json() as { run: { id: string } }).run.id;

    const status = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT}/runs/${runId}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { id: string }).id).toBe(runId);

    const history = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT}/chats/${CHAT}/messages`,
      headers: auth,
    });
    expect(history.statusCode).toBe(200);
    const page = history.json() as { items: { role: string }[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.role).toBe('user');
    expect(page.next_cursor).toBeNull();
  });

  it('404s a run in a different project (cross-project isolation)', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: createUrl,
      headers: withKey,
      payload: createBody(),
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/00000000-0000-4000-8000-000000000077/runs/${runId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * DB integration tests for T09 (durable Ask & chat persistence) against live
 * PostgreSQL 16. Imports package SOURCE by relative path (D09) and skips LOUDLY
 * without DATABASE_URL. Proves against the real schema what the in-memory suite
 * proves against the fake:
 *   - idempotent create (repeated key + a live-concurrent double-submit → one run);
 *   - the run/message are durable and readable after the create-commit (API crash);
 *   - a full Ask step through the DB + the labelled mock provider;
 *   - Ask writes NO tool_calls / task_attempts rows (empty toolset, no worker task);
 *   - lease-expiry recovery finalizes without duplicating the final message (fence).
 */
import { describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase, insertBaseGraph } from './support.js';
import {
  AskService,
  canonicalBodyHash,
  createDbMessagesRepository,
  createDbAskContextBuilder,
} from '../../../packages/application/src/messages/index.js';
import type {
  ClaimedRun,
  ProviderResolver,
} from '../../../packages/application/src/messages/index.js';
import { MockProvider } from '../../../packages/llm/src/index.js';
import type { MockFixture, ProviderCandidate } from '../../../packages/llm/src/index.js';
import { AskRuntimeDriver } from '../../../apps/runtime/src/ask/driver.js';
import type { Pool } from '../../../packages/db/src/index.js';

const d = HAS_DB ? describe : describe.skip;

const CLIENT_MSG = '00000000-0000-4000-8000-0000000000aa';

function textFixture(text: string): MockFixture {
  return { id: 't', events: [{ text }, { usage: { input_tokens: 2, output_tokens: 1 } }, { finish: 'stop' }] };
}
function toolFixture(): MockFixture {
  return {
    id: 'tool',
    events: [
      { text: 'safe reply' },
      { tool_call: { index: 0, id: 'c1', name: 'terminal.execute', arguments: '{"cmd":"x"}' } },
      { finish: 'tool_calls' },
    ],
  };
}
function resolverFor(provider: MockProvider): ProviderResolver {
  return {
    async resolve() {
      const candidate: ProviderCandidate = {
        provider,
        allowedDataModes: ['local_only', 'redacted_cloud', 'cloud_full'],
        isLocalEndpoint: true,
      };
      return { candidates: [candidate], dataMode: 'redacted_cloud' };
    },
  };
}

interface Base {
  workspaceId: string;
  projectId: string;
  chatId: string;
  providerConfigId: string;
}

function makeService(pool: Pool, provider: MockProvider): AskService {
  return new AskService({
    repo: createDbMessagesRepository(pool),
    context: createDbAskContextBuilder(pool),
    provider: resolverFor(provider),
  });
}

function createInput(base: Base, key: string, text = 'What is redAI?') {
  return {
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    chatId: base.chatId,
    providerConfigId: base.providerConfigId,
    text,
    clientMessageId: CLIENT_MSG,
    idempotency: {
      actorKey: 'owner',
      method: 'POST',
      route: `/api/v1/projects/${base.projectId}/chats/${base.chatId}/runs`,
      key,
    },
  };
}

d('T09 durable Ask create — idempotency (live PG)', () => {
  it('a repeated Idempotency-Key with the same body returns the SAME run', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const svc = makeService(db.pool, new MockProvider({ fixtures: [textFixture('hi')] }));
      const input = createInput(base, '00000000-0000-4000-8000-0000000000f1');
      const sha = canonicalBodyHash({ input: 1 });

      const a = await svc.createAskRun(input, sha);
      const b = await svc.createAskRun(input, sha);
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.run.id).toBe(a.run.id);

      const runs = await db.pool.query('SELECT count(*)::int AS n FROM runs WHERE chat_id = $1', [
        base.chatId,
      ]);
      expect(runs.rows[0].n).toBe(1);
      const msgs = await db.pool.query(
        `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND role = 'user'`,
        [base.chatId],
      );
      expect(msgs.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('a live-concurrent double-submit (same key) creates exactly one run', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const svc = makeService(db.pool, new MockProvider({ fixtures: [textFixture('hi')] }));
      const input = createInput(base, '00000000-0000-4000-8000-0000000000f2');
      const sha = canonicalBodyHash({ input: 2 });

      const [a, b] = await Promise.all([svc.createAskRun(input, sha), svc.createAskRun(input, sha)]);
      expect(a.run.id).toBe(b.run.id);

      const runs = await db.pool.query('SELECT count(*)::int AS n FROM runs WHERE chat_id = $1', [
        base.chatId,
      ]);
      expect(runs.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('a reused key with a DIFFERENT body is a conflict', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const svc = makeService(db.pool, new MockProvider({ fixtures: [textFixture('hi')] }));
      const input = createInput(base, '00000000-0000-4000-8000-0000000000f3');
      await svc.createAskRun(input, canonicalBodyHash({ v: 1 }));
      await expect(svc.createAskRun(input, canonicalBodyHash({ v: 2 }))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    } finally {
      await db.drop();
    }
  });
});

d('T09 durable Ask — readability after a create-commit (API crash)', () => {
  it('the run and user message are readable; a retry does not re-create', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const svc = makeService(db.pool, new MockProvider({ fixtures: [textFixture('hi')] }));
      const input = createInput(base, '00000000-0000-4000-8000-0000000000f4');
      const sha = canonicalBodyHash({ v: 3 });
      const created = await svc.createAskRun(input, sha);

      // A "fresh process" (new repository over the same DB) re-reads after the commit.
      const svc2 = makeService(db.pool, new MockProvider({ fixtures: [textFixture('hi')] }));
      const run = await svc2.getRun(base.workspaceId, base.projectId, created.run.id);
      expect(run.state).toBe('queued');
      const page = await svc2.listMessages(base.workspaceId, base.projectId, base.chatId, { limit: 50 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.role).toBe('user');

      // The retry replays; still one run + one user message.
      const retry = await svc2.createAskRun(input, sha);
      expect(retry.created).toBe(false);
      const n = await db.pool.query('SELECT count(*)::int AS n FROM runs WHERE chat_id = $1', [base.chatId]);
      expect(n.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });
});

d('T09 durable Ask step — end-to-end via DB + mock provider', () => {
  it('runs a full Ask step, persists the completed reply, and creates NO tool rows', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const provider = new MockProvider({ fixtures: [toolFixture()] });
      const svc = makeService(db.pool, provider);
      const repo = createDbMessagesRepository(db.pool);
      await svc.createAskRun(createInput(base, '00000000-0000-4000-8000-0000000000f5'), canonicalBodyHash({ v: 4 }));

      const driver = new AskRuntimeDriver({
        repo,
        runStep: (claimed: ClaimedRun) => svc.runStep(claimed),
        owner: 'runtime-1',
      });
      const tick = await driver.tickOnce();
      expect(tick.claimed).toBe(true);
      expect(tick.step?.outcome).toBe('completed');

      const run = await db.pool.query(`SELECT state FROM runs WHERE chat_id = $1`, [base.chatId]);
      expect(run.rows[0].state).toBe('completed');

      const assistant = await db.pool.query(
        `SELECT text_content, status, content_json FROM messages
         WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(assistant.rows).toHaveLength(1);
      expect(assistant.rows[0].status).toBe('completed');
      expect(assistant.rows[0].text_content).toBe('safe reply');

      // Ask has an EMPTY toolset: the mock captured tools = [].
      expect(provider.lastCapture()?.neutral.tools).toEqual([]);

      // No worker task / tool output was created for an Ask.
      const toolCalls = await db.pool.query('SELECT count(*)::int AS n FROM tool_calls');
      const attempts = await db.pool.query('SELECT count(*)::int AS n FROM task_attempts');
      expect(toolCalls.rows[0].n).toBe(0);
      expect(attempts.rows[0].n).toBe(0);
    } finally {
      await db.drop();
    }
  });
});

d('T09 durable Ask — lease-expiry recovery (generation fence)', () => {
  it('recovers a run whose lease expired mid-step without duplicating the final message', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const provider = new MockProvider({ fixtures: [textFixture('final answer')] });
      const svc = makeService(db.pool, provider);
      const repo = createDbMessagesRepository(db.pool);
      const created = await svc.createAskRun(
        createInput(base, '00000000-0000-4000-8000-0000000000f6'),
        canonicalBodyHash({ v: 5 }),
      );

      // Runtime A claims with an already-expired lease and begins the partial only.
      const claimedA = await repo.claimQueuedAskRun('runtime-A', new Date(), new Date(Date.now() - 5000));
      const begun = await repo.beginAssistantMessage({
        runId: created.run.id,
        workspaceId: base.workspaceId,
        projectId: base.projectId,
        chatId: base.chatId,
        expectedFence: claimedA!.fence,
        assistantMessageId: '00000000-0000-4000-8000-0000000000b1',
        now: new Date(),
      });
      expect(begun.result).toBe('ok');

      // Runtime B ticks: it claims the expired run (new fence) and finishes the step.
      const driver = new AskRuntimeDriver({
        repo,
        runStep: (claimed: ClaimedRun) => svc.runStep(claimed),
        owner: 'runtime-B',
      });
      const tick = await driver.tickOnce();
      expect(tick.claimed).toBe(true);
      expect(tick.step?.outcome).toBe('completed');

      // A wakes and tries to finalize with its STALE fence — must be rejected.
      const stale = await repo.finalizeAssistant({
        runId: created.run.id,
        workspaceId: base.workspaceId,
        assistantMessageId: '00000000-0000-4000-8000-0000000000b1',
        expectedFence: claimedA!.fence,
        text: 'ghost',
        sha256: 'x',
        generationId: claimedA!.fence,
        providerLabel: 'stale',
        isMock: true,
        usage: { kind: 'unknown' },
        finishReason: 'stop',
        now: new Date(),
      });
      expect(stale).toBe('stale');

      // Exactly ONE assistant message, completed with B's answer.
      const rows = await db.pool.query(
        `SELECT text_content, status FROM messages WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe('completed');
      expect(rows.rows[0].text_content).toBe('final answer');
    } finally {
      await db.drop();
    }
  });
});

d('T09 chat history pagination (live PG)', () => {
  it('paginates chat messages by seq with an opaque cursor', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const provider = new MockProvider({ fixtures: [textFixture('answer')] });
      const svc = makeService(db.pool, provider);
      const repo = createDbMessagesRepository(db.pool);
      await svc.createAskRun(createInput(base, '00000000-0000-4000-8000-0000000000f7'), canonicalBodyHash({ v: 6 }));
      const driver = new AskRuntimeDriver({
        repo,
        runStep: (claimed: ClaimedRun) => svc.runStep(claimed),
        owner: 'runtime-1',
      });
      await driver.tickOnce();

      const first = await svc.listMessages(base.workspaceId, base.projectId, base.chatId, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await svc.listMessages(base.workspaceId, base.projectId, base.chatId, {
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(BigInt(second.items[0]!.seq)).toBeGreaterThan(BigInt(first.items[0]!.seq));
    } finally {
      await db.drop();
    }
  });
});

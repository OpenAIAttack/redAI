/**
 * DB integration tests for T13 (durable Agent loop & checkpoints) against live
 * PostgreSQL 16. Imports package SOURCE by relative path (D09) and skips LOUDLY without
 * DATABASE_URL. Proves against the real schema what the in-memory suite proves against
 * the fake:
 *   - a full agent step through the DB + a mock provider + a MOCK tool transport runs
 *     one tool then finalizes: exactly one dispatch, one final assistant message;
 *   - restart at a mid-run boundary (a fresh runtime over the same DB) resumes from the
 *     checkpoint with NO duplicate logical tool call and NO duplicate final message;
 *   - two runtimes racing: the stale fence's commit is rejected (exactly one advances);
 *   - a malformed model response creates NO tool_calls / task_attempts rows and lands
 *     the run in needs_attention.
 */
import { describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase, insertBaseGraph } from './support.js';
import {
  AgentService,
  createDbAgentRunRepository,
  MockToolTransport,
  allowAllAuthorizer,
} from '../../../packages/application/src/agent/index.js';
import type {
  AgentContextBuilder,
  AgentContextInputs,
  CreateAgentRunInput,
  ProviderResolver,
} from '../../../packages/application/src/agent/index.js';
import { canonicalBodyHash } from '../../../packages/application/src/messages/index.js';
import { MockProvider } from '../../../packages/llm/src/index.js';
import type { GenerateResult, ModelProvider, MockFixture } from '../../../packages/llm/src/index.js';
import { AgentRuntimeDriver } from '../../../apps/runtime/src/agent/driver.js';
import type { Pool } from '../../../packages/db/src/index.js';

const d = HAS_DB ? describe : describe.skip;

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const CLIENT = '00000000-0000-4000-8000-0000000000bb';

const emptyContext: AgentContextBuilder = {
  async build(): Promise<AgentContextInputs> {
    return { selectedNotes: [], attachedFiles: [], history: [] };
  },
};

const VALID_HTTP = {
  scheme: 'https',
  host: 'example.test',
  port: 443,
  path: '/',
  method: 'GET',
  follow_redirects: false,
  max_redirects: 0,
  max_response_bytes: 1000,
};
const RESULTS_MARKER = 'Tool results so far';

function providerFrom(gen: (messages: { content: string }[]) => GenerateResult): ModelProvider {
  return {
    info: {
      kind: 'mock',
      label: 'MOCK — scripted',
      isMock: true,
      capabilities: { text: true, tools: true, streaming: true, structuredOutput: true, vision: false },
    },
    async generate(request): Promise<GenerateResult> {
      return gen(request.messages);
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<never> {
      throw new Error('unused');
    },
  };
}

function switchingProvider(): ModelProvider {
  return providerFrom((messages) => {
    const hasResults = messages.some((m) => m.content.includes(RESULTS_MARKER));
    if (hasResults) {
      return {
        text: 'done',
        usage: { kind: 'known', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
        isMock: true,
        providerLabel: 'MOCK — scripted',
      };
    }
    return {
      text: 'planning',
      toolCalls: [
        { id: 'p0', index: 0, name: 'http.request', argumentsRaw: JSON.stringify(VALID_HTTP), arguments: VALID_HTTP },
      ],
      usage: { kind: 'known', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      finishReason: 'tool_calls',
      isMock: true,
      providerLabel: 'MOCK — scripted',
    };
  });
}

function resolverFor(provider: ModelProvider): ProviderResolver {
  return {
    async resolve() {
      return {
        candidates: [
          { provider, allowedDataModes: ['local_only', 'redacted_cloud', 'cloud_full'], isLocalEndpoint: true },
        ],
        dataMode: 'redacted_cloud',
      };
    },
  };
}

interface Base {
  workspaceId: string;
  projectId: string;
  chatId: string;
  providerConfigId: string;
}

function makeService(pool: Pool, provider: ModelProvider, transport: MockToolTransport): AgentService {
  return new AgentService({
    repo: createDbAgentRunRepository(pool),
    context: emptyContext,
    provider: resolverFor(provider),
    transport,
    authorizer: allowAllAuthorizer,
    activeMsPerStep: 0,
  });
}

function createInput(base: Base, key: string): CreateAgentRunInput {
  const now = new Date();
  return {
    workspaceId: base.workspaceId,
    projectId: base.projectId,
    chatId: base.chatId,
    runId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    agentSessionId: SESSION,
    providerConfigId: base.providerConfigId,
    text: 'Probe the target',
    clientMessageId: CLIENT,
    attachedArtifactIds: [],
    dataMode: 'redacted_cloud',
    budgetLimitMicroUsd: '2000000',
    maxSteps: 40,
    expiresAt: new Date(now.getTime() + 86400000),
    now,
    idempotency: {
      workspaceId: base.workspaceId,
      actorKey: 'owner',
      method: 'POST',
      route: `/api/v1/projects/${base.projectId}/chats/${base.chatId}/runs`,
      key,
      bodySha256: canonicalBodyHash({ key }),
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };
}

d('T13 durable Agent step — end-to-end via DB + mock provider + mock transport', () => {
  it('runs one tool then finalizes; one dispatch, one final message, NO task_attempts', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const repo = createDbAgentRunRepository(db.pool);
      const transport = new MockToolTransport();
      const svc = makeService(db.pool, switchingProvider(), transport);
      const created = await svc.createAgentRun(createInput(base, '00000000-0000-4000-8000-0000000000f1'));
      expect(created.kind).toBe('created');

      const driver = new AgentRuntimeDriver({ repo, service: svc, owner: 'rt-1' });
      await driver.drain();

      const run = await db.pool.query(`SELECT state, step_count, plan_revision FROM runs WHERE chat_id = $1`, [base.chatId]);
      expect(run.rows[0].state).toBe('completed');

      const assistant = await db.pool.query(
        `SELECT text_content, status FROM messages WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(assistant.rows).toHaveLength(1);
      expect(assistant.rows[0].status).toBe('completed');
      expect(assistant.rows[0].text_content).toBe('done');
      expect(transport.dispatched).toHaveLength(1);

      // T13 does NOT create real attempts (T17 dispatches) — pending calls live in the checkpoint.
      const attempts = await db.pool.query('SELECT count(*)::int AS n FROM task_attempts');
      const toolCalls = await db.pool.query('SELECT count(*)::int AS n FROM tool_calls');
      expect(attempts.rows[0].n).toBe(0);
      expect(toolCalls.rows[0].n).toBe(0);
    } finally {
      await db.drop();
    }
  });
});

d('T13 restart at a mid-run boundary (generation fence)', () => {
  it('a fresh runtime resumes from the checkpoint without duplicating the dispatch or message', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const repo = createDbAgentRunRepository(db.pool);
      const transport = new MockToolTransport();
      const svc = makeService(db.pool, switchingProvider(), transport);
      const created = await svc.createAgentRun(createInput(base, '00000000-0000-4000-8000-0000000000f2'));

      // Runtime A: claim + advance exactly ONE phase (commit model_committed), then "die"
      // (we do not release — simulate a crash by leaving the lease to expire).
      const driverA = new AgentRuntimeDriver({ repo, service: svc, owner: 'rt-A', leaseSeconds: -1 });
      const one = await driverA.tickOnce();
      expect(one.outcome).toBe('stepped');

      // Runtime B: drains to completion from the durable checkpoint.
      const driverB = new AgentRuntimeDriver({ repo, service: svc, owner: 'rt-B' });
      await driverB.drain();

      const run = await db.pool.query(`SELECT state FROM runs WHERE id = $1`, [created.run.id]);
      expect(run.rows[0].state).toBe('completed');
      const assistant = await db.pool.query(
        `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(assistant.rows[0].n).toBe(1);
      // Each logical id dispatched at most once across the restart.
      for (const id of new Set(transport.dispatched)) {
        expect(transport.countFor(id)).toBe(1);
      }
      expect(transport.dispatched.length).toBeLessThanOrEqual(1);
    } finally {
      await db.drop();
    }
  });
});

d('T13 two runtimes — stale fence rejected', () => {
  it('the stale runtime commit is rejected; exactly one advances', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const repo = createDbAgentRunRepository(db.pool);
      const transport = new MockToolTransport();
      const svc = makeService(db.pool, switchingProvider(), transport);
      const created = await svc.createAgentRun(createInput(base, '00000000-0000-4000-8000-0000000000f3'));

      // Runtime A claims with an already-expired lease.
      const claimedA = await repo.claimQueuedAgentRun('rt-A', new Date(), new Date(Date.now() - 5000));
      expect(claimedA).not.toBeNull();

      // Runtime B drains it to completion (fresh fence each phase).
      const driverB = new AgentRuntimeDriver({ repo, service: svc, owner: 'rt-B' });
      await driverB.drain();
      const run = await db.pool.query(`SELECT state FROM runs WHERE id = $1`, [created.run.id]);
      expect(run.rows[0].state).toBe('completed');

      // Runtime A wakes with its STALE fence — the commit must be rejected.
      const stale = await svc.runStep(claimedA!);
      expect(stale.outcome).toBe('stale');

      const assistant = await db.pool.query(
        `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(assistant.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });
});

d('T13 invalid model response — NO dispatch', () => {
  it('malformed tool-call JSON → needs_attention, no task rows, no dispatch', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const repo = createDbAgentRunRepository(db.pool);
      const transport = new MockToolTransport();
      const fixture: MockFixture = {
        id: 'bad',
        events: [
          { tool_call: { index: 0, id: 'c1', name: 'http.request', arguments: '{not json' } },
          { finish: 'tool_calls' },
        ],
      };
      const svc = makeService(db.pool, new MockProvider({ fixtures: [fixture] }), transport);
      const created = await svc.createAgentRun(createInput(base, '00000000-0000-4000-8000-0000000000f4'));

      const driver = new AgentRuntimeDriver({ repo, service: svc, owner: 'rt-1' });
      await driver.drain();

      const run = await db.pool.query(`SELECT state, stop_reason FROM runs WHERE id = $1`, [created.run.id]);
      expect(run.rows[0].state).toBe('needs_attention');
      expect(run.rows[0].stop_reason).toBe('MODEL_OUTPUT_INVALID');
      expect(transport.dispatched).toHaveLength(0);

      const attempts = await db.pool.query('SELECT count(*)::int AS n FROM task_attempts');
      expect(attempts.rows[0].n).toBe(0);
      const assistant = await db.pool.query(
        `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND role = 'assistant'`,
        [base.chatId],
      );
      expect(assistant.rows[0].n).toBe(0);
    } finally {
      await db.drop();
    }
  });
});

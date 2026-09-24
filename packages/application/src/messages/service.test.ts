/**
 * Unit tests for the durable Ask & chat-persistence use cases against the in-memory
 * repository and the LABELLED mock provider (no DB, no network). These prove the
 * behaviours the DB integration suite then re-proves against live PostgreSQL:
 * idempotent create, empty toolset, no tool output in an Ask, monotonic-generation
 * lease-expiry recovery without a duplicate final message, and idempotent replay
 * after a create-commit.
 */
import { describe, expect, it } from 'vitest';
import { MockProvider, MOCK_LABEL } from '@redai/llm';
import type { MockFixture, ProviderCandidate } from '@redai/llm';
import { AskService, canonicalBodyHash } from './service.js';
import { InMemoryMessagesRepository } from './memoryRepository.js';
import type { AskContextBuilder, AskContextInputs, ProviderResolver } from './ports.js';

const WS = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const CHAT = '00000000-0000-4000-8000-000000000003';
const PROVIDER = '00000000-0000-4000-8000-000000000004';
const OWNER = 'owner-1';

function emptyContext(): AskContextBuilder {
  return {
    async build(): Promise<AskContextInputs> {
      return { selectedNotes: [], attachedFiles: [], history: [] };
    },
  };
}

function textFixture(text: string): MockFixture {
  return {
    id: 'text',
    events: [{ text }, { usage: { input_tokens: 3, output_tokens: 2 } }, { finish: 'stop' }],
  };
}

/** A fixture that scripts a tool call AND text; an Ask must ignore the tool call. */
function toolPlusTextFixture(): MockFixture {
  return {
    id: 'tool',
    events: [
      { text: 'plain answer' },
      {
        tool_call: { index: 0, id: 'call_1', name: 'terminal.execute', arguments: '{"cmd":"rm"}' },
      },
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

function makeService(
  provider: MockProvider,
  repo = new InMemoryMessagesRepository(),
): {
  svc: AskService;
  repo: InMemoryMessagesRepository;
} {
  const svc = new AskService({
    repo,
    context: emptyContext(),
    provider: resolverFor(provider),
    clock: { now: () => new Date('2026-09-24T00:00:00Z') },
  });
  return { svc, repo };
}

function createInput(overrides: Partial<Parameters<AskService['createAskRun']>[0]> = {}) {
  const clientMessageId = '00000000-0000-4000-8000-0000000000aa';
  return {
    workspaceId: WS,
    projectId: PROJECT,
    chatId: CHAT,
    providerConfigId: PROVIDER,
    text: 'What is redAI?',
    clientMessageId,
    idempotency: {
      actorKey: OWNER,
      method: 'POST',
      route: `/api/v1/projects/${PROJECT}/chats/${CHAT}/runs`,
      key: '00000000-0000-4000-8000-0000000000ff',
    },
    ...overrides,
  };
}

describe('AskService.createAskRun idempotency', () => {
  it('a repeated Idempotency-Key with the same body returns the SAME run', async () => {
    const { svc, repo } = makeService(new MockProvider({ fixtures: [textFixture('hi')] }));
    const input = createInput();
    const sha = canonicalBodyHash({ ...input.idempotency });

    const a = await svc.createAskRun(input, sha);
    const b = await svc.createAskRun(input, sha);

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    expect(repo._messagesForChat(CHAT).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('a double-submit (Promise.all, same key) creates exactly one run', async () => {
    const { svc, repo } = makeService(new MockProvider({ fixtures: [textFixture('hi')] }));
    const input = createInput();
    const sha = canonicalBodyHash({ ...input.idempotency });

    const [a, b] = await Promise.all([svc.createAskRun(input, sha), svc.createAskRun(input, sha)]);
    expect(a.run.id).toBe(b.run.id);
    const runs = new Set(repo._messagesForChat(CHAT).map((m) => m.runId));
    expect(runs.size).toBe(1);
    expect(repo._messagesForChat(CHAT).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('the same key with a different body is a conflict', async () => {
    const { svc } = makeService(new MockProvider({ fixtures: [textFixture('hi')] }));
    const input = createInput();
    await svc.createAskRun(input, canonicalBodyHash({ a: 1 }));
    await expect(svc.createAskRun(input, canonicalBodyHash({ a: 2 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('a different key but same client_message_id de-duplicates to one run', async () => {
    const { svc, repo } = makeService(new MockProvider({ fixtures: [textFixture('hi')] }));
    const base = createInput();
    const a = await svc.createAskRun(base, canonicalBodyHash({ n: 1 }));
    const b = await svc.createAskRun(
      {
        ...base,
        idempotency: { ...base.idempotency, key: '00000000-0000-4000-8000-0000000000ee' },
      },
      canonicalBodyHash({ n: 2 }),
    );
    expect(b.run.id).toBe(a.run.id);
    expect(repo._messagesForChat(CHAT).filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('AskService end-to-end via the mock provider', () => {
  it('persists a completed assistant message and marks the run completed', async () => {
    const provider = new MockProvider({ fixtures: [textFixture('redAI is a personal agent.')] });
    const { svc, repo } = makeService(provider);
    const input = createInput();
    const created = await svc.createAskRun(input, canonicalBodyHash({ x: 1 }));

    const claimed = await repo.claimQueuedAskRun(OWNER, new Date(), new Date(Date.now() + 60000));
    expect(claimed).not.toBeNull();
    const step = await svc.runStep(claimed!);

    expect(step.outcome).toBe('completed');
    expect(step.isMock).toBe(true);
    expect(step.providerLabel).toBe(MOCK_LABEL);

    const run = repo._run(created.run.id)!;
    expect(run.state).toBe('completed');
    expect(run.runtimeLeaseUntil).toBeNull();

    const assistant = repo._messagesForChat(CHAT).find((m) => m.role === 'assistant')!;
    expect(assistant.status).toBe('completed');
    expect(assistant.textContent).toBe('redAI is a personal agent.');
    expect(assistant.contentJson['is_mock']).toBe(true);

    // Empty toolset: the mock captured tools = [].
    expect(provider.lastCapture()?.neutral.tools).toEqual([]);
  });

  it('ignores scripted tool calls: an Ask never surfaces tool output', async () => {
    const provider = new MockProvider({ fixtures: [toolPlusTextFixture()] });
    const { svc, repo } = makeService(provider);
    await svc.createAskRun(createInput(), canonicalBodyHash({ x: 2 }));
    const claimed = await repo.claimQueuedAskRun(OWNER, new Date(), new Date(Date.now() + 60000));
    const step = await svc.runStep(claimed!);

    expect(step.outcome).toBe('completed');
    const assistant = repo._messagesForChat(CHAT).find((m) => m.role === 'assistant')!;
    expect(assistant.textContent).toBe('plain answer');
    // No tool name/arguments (i.e. no executable tool output) leaked into the message.
    const serialized = JSON.stringify(assistant.contentJson);
    expect(serialized).not.toContain('terminal.execute');
    expect(serialized).not.toContain('rm');
    expect(provider.lastCapture()?.neutral.tools).toEqual([]);
  });
});

describe('AskService lease-expiry recovery (generation id)', () => {
  it('a resumed run does not duplicate the final assistant message', async () => {
    const provider = new MockProvider({ fixtures: [textFixture('final answer')] });
    const { svc, repo } = makeService(provider);
    const created = await svc.createAskRun(createInput(), canonicalBodyHash({ x: 3 }));

    // Runtime A claims and begins (partial persisted) but "dies" before finalize.
    const claimedA = await repo.claimQueuedAskRun(
      'runtime-A',
      new Date(),
      new Date(Date.now() - 1000),
    );
    await repo.beginAssistantMessage({
      runId: created.run.id,
      workspaceId: WS,
      projectId: PROJECT,
      chatId: CHAT,
      expectedFence: claimedA!.fence,
      assistantMessageId: '00000000-0000-4000-8000-0000000000b1',
      now: new Date(),
    });
    const assistantIdsBefore = repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
    expect(assistantIdsBefore).toHaveLength(1);
    expect(assistantIdsBefore[0]!.status).toBe('streaming');

    // Runtime B claims the same run (A's lease expired) and runs the full step.
    const claimedB = await repo.claimQueuedAskRun(
      'runtime-B',
      new Date(),
      new Date(Date.now() + 60000),
    );
    expect(claimedB).not.toBeNull();
    expect(BigInt(claimedB!.fence)).toBeGreaterThan(BigInt(claimedA!.fence));
    const stepB = await svc.runStep(claimedB!);
    expect(stepB.outcome).toBe('completed');

    // A wakes up and tries to finalize with its STALE fence — must be rejected.
    const staleFinal = await repo.finalizeAssistant({
      runId: created.run.id,
      workspaceId: WS,
      assistantMessageId: '00000000-0000-4000-8000-0000000000b1',
      expectedFence: claimedA!.fence,
      text: 'ghost answer',
      sha256: 'x',
      generationId: claimedA!.fence,
      providerLabel: 'stale',
      isMock: true,
      usage: { kind: 'unknown' },
      finishReason: 'stop',
      now: new Date(),
    });
    expect(staleFinal).toBe('stale');

    // Exactly ONE assistant message, completed with B's answer.
    const assistants = repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toBe('completed');
    expect(assistants[0]!.textContent).toBe('final answer');
  });
});

describe('AskService history & readability after a create-commit', () => {
  it('run and user message are readable; create replays instead of re-creating', async () => {
    const provider = new MockProvider({ fixtures: [textFixture('hi')] });
    const { svc, repo } = makeService(provider);
    const input = createInput();
    const sha = canonicalBodyHash({ x: 4 });
    const first = await svc.createAskRun(input, sha);

    // Simulate an API crash after commit: the client retries the same request.
    const retry = await svc.createAskRun(input, sha);
    expect(retry.created).toBe(false);
    expect(retry.run.id).toBe(first.run.id);

    const run = await svc.getRun(WS, PROJECT, first.run.id);
    expect(run.state).toBe('queued');

    const page = await svc.listMessages(WS, PROJECT, CHAT, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.role).toBe('user');
    expect(page.items[0]!.textContent).toBe('What is redAI?');
    expect(repo._messagesForChat(CHAT)).toHaveLength(1);
  });

  it('paginates history by seq', async () => {
    const provider = new MockProvider({ fixtures: [textFixture('answer')] });
    const { svc, repo } = makeService(provider);
    await svc.createAskRun(createInput(), canonicalBodyHash({ x: 5 }));
    const claimed = await repo.claimQueuedAskRun(OWNER, new Date(), new Date(Date.now() + 60000));
    await svc.runStep(claimed!);

    const first = await svc.listMessages(WS, PROJECT, CHAT, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await svc.listMessages(WS, PROJECT, CHAT, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.seq).not.toBe(first.items[0]!.seq);
  });
});

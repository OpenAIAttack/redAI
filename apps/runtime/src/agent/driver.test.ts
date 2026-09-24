/**
 * Unit tests for the durable Agent loop (T13) against the in-memory repository, a
 * deterministic mock provider and a MOCK tool transport (no network, no real dispatch).
 *
 * Proves the docs/07 §10 acceptance:
 *   - Restart at EVERY checkpoint boundary resumes from the checkpoint with NO duplicate
 *     logical tool call and NO duplicate final message.
 *   - Two runtimes racing on one run: the stale fence's commit is rejected; exactly one
 *     advances.
 *   - An invalid/malformed model response produces NO tool dispatch and lands the run in
 *     needs_attention (not a fake success).
 *   - Loop detection and max_steps / active / absolute timeouts terminate the run in the
 *     correct terminal state.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentService,
  InMemoryAgentRunRepository,
  MockToolTransport,
  allowAllAuthorizer,
  denyAllAuthorizer,
  type AgentContextBuilder,
  type AgentContextInputs,
  type AgentRunRepository,
  type CreateAgentRunInput,
  type ProviderResolver,
  type RunRecord,
  MockProvider,
  type ModelProvider,
  type GenerateResult,
  type MockFixture,
} from '@redai/application/agent';
import { canonicalBodyHash } from '@redai/application/messages';
import { AgentRuntimeDriver } from './driver.js';

const WS = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const CHAT = '00000000-0000-4000-8000-000000000003';
const PROVIDER = '00000000-0000-4000-8000-000000000004';
const SESSION = '00000000-0000-4000-8000-000000000005';

let counter = 0;
const uid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

const emptyContext: AgentContextBuilder = {
  async build(): Promise<AgentContextInputs> {
    return { selectedNotes: [], attachedFiles: [], history: [] };
  },
};

function resolverFor(provider: ModelProvider): ProviderResolver {
  return {
    async resolve() {
      return {
        candidates: [
          {
            provider,
            allowedDataModes: ['local_only', 'redacted_cloud', 'cloud_full'],
            isLocalEndpoint: true,
          },
        ],
        dataMode: 'redacted_cloud',
      };
    },
  };
}

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

function toolResult(args: unknown): GenerateResult {
  return {
    text: 'planning a request',
    toolCalls: [
      {
        id: 'prov-0',
        index: 0,
        name: 'http.request',
        argumentsRaw: JSON.stringify(args),
        arguments: args,
      },
    ],
    usage: { kind: 'known', inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    finishReason: 'tool_calls',
    isMock: true,
    providerLabel: 'MOCK — scripted',
  };
}

function finalResult(text: string): GenerateResult {
  return {
    text,
    usage: { kind: 'known', inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    finishReason: 'stop',
    isMock: true,
    providerLabel: 'MOCK — scripted',
  };
}

const RESULTS_MARKER = 'Tool results so far';

/** Base for a hand-rolled ModelProvider (only `generate` is exercised by the loop). */
function providerFrom(gen: (messages: { content: string }[]) => GenerateResult): ModelProvider {
  return {
    info: {
      kind: 'mock',
      label: 'MOCK — scripted',
      isMock: true,
      capabilities: {
        text: true,
        tools: true,
        streaming: true,
        structuredOutput: true,
        vision: false,
      },
    },
    async generate(request): Promise<GenerateResult> {
      return gen(request.messages);
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<never> {
      throw new Error('stream not used by the agent loop');
    },
  };
}

/** Step 1 requests one tool; once results are in context, finalizes. */
function switchingProvider(): ModelProvider {
  return providerFrom((messages) => {
    const hasResults = messages.some((m) => m.content.includes(RESULTS_MARKER));
    return hasResults ? finalResult('done: request completed') : toolResult(VALID_HTTP);
  });
}

/** Always requests the SAME tool with the SAME args (drives loop detection). */
function alwaysToolProvider(): ModelProvider {
  return providerFrom(() => toolResult(VALID_HTTP));
}

function makeService(
  repo: AgentRunRepository,
  provider: ModelProvider,
  transport: MockToolTransport,
  opts: { authorizer?: typeof allowAllAuthorizer } = {},
): AgentService {
  return new AgentService({
    repo,
    context: emptyContext,
    provider: resolverFor(provider),
    transport,
    authorizer: opts.authorizer ?? allowAllAuthorizer,
    activeMsPerStep: 0,
  });
}

function createInput(
  key: string,
  opts: { maxSteps?: number; now?: Date } = {},
): CreateAgentRunInput {
  const now = opts.now ?? new Date();
  return {
    workspaceId: WS,
    projectId: PROJECT,
    chatId: CHAT,
    runId: uid(),
    userMessageId: uid(),
    agentSessionId: SESSION,
    providerConfigId: PROVIDER,
    text: 'Probe the target',
    clientMessageId: uid(),
    attachedArtifactIds: [],
    dataMode: 'redacted_cloud',
    budgetLimitMicroUsd: '2000000',
    maxSteps: opts.maxSteps ?? 40,
    expiresAt: new Date(now.getTime() + 86400000),
    now,
    idempotency: {
      workspaceId: WS,
      actorKey: 'owner',
      method: 'POST',
      route: '/r',
      key,
      bodySha256: canonicalBodyHash({ key }),
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };
}

async function seed(
  repo: AgentRunRepository,
  key: string,
  opts?: { maxSteps?: number },
): Promise<string> {
  const out = await repo.createAgentRun(createInput(key, opts));
  if (out.kind !== 'created') throw new Error(`expected created, got ${out.kind}`);
  return out.run.id;
}

describe('AgentRuntimeDriver — happy path', () => {
  it('runs one tool then finalizes: exactly one dispatch and one final message', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'k1');
    const transport = new MockToolTransport();
    const service = makeService(repo, switchingProvider(), transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });

    const result = await driver.runToCompletion();
    expect(result.outcome).toBe('completed');
    expect(repo._run(runId)!.state).toBe('completed');

    const assistants = repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe('done: request completed');
    expect(transport.dispatched).toHaveLength(1);
  });

  it('a completed run is not re-claimed', async () => {
    const repo = new InMemoryAgentRunRepository();
    await seed(repo, 'k2');
    const transport = new MockToolTransport();
    const service = makeService(repo, switchingProvider(), transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    expect(await driver.tickOnce()).toEqual({ claimed: false });
    expect(transport.dispatched).toHaveLength(1);
  });
});

/**
 * A repository decorator that performs the real write, then throws ONCE after the Nth
 * fence-guarded write — simulating a runtime crash immediately after a checkpoint
 * boundary committed. Subsequent writes pass through so a resumed runtime completes.
 */
function crashingRepo(base: InMemoryAgentRunRepository, throwAfter: number): AgentRunRepository {
  let writes = 0;
  let armed = true;
  const maybeThrow = (): void => {
    writes += 1;
    if (armed && writes === throwAfter) {
      armed = false;
      throw new Error(`simulated crash after boundary ${throwAfter}`);
    }
  };
  return {
    createAgentRun: (i) => base.createAgentRun(i),
    getRun: (a, b, c) => base.getRun(a, b, c),
    listMessages: (a, b, c, d) => base.listMessages(a, b, c, d),
    claimQueuedAgentRun: (a, b, c) => base.claimQueuedAgentRun(a, b, c),
    releaseLease: (a, b, c) => base.releaseLease(a, b, c),
    commitCheckpoint: async (i) => {
      const r = await base.commitCheckpoint(i);
      if (r === 'ok') maybeThrow();
      return r;
    },
    finalizeAgentRun: async (i) => {
      const r = await base.finalizeAgentRun(i);
      if (r === 'ok') maybeThrow();
      return r;
    },
    terminateAgentRun: async (i) => {
      const r = await base.terminateAgentRun(i);
      if (r === 'ok') maybeThrow();
      return r;
    },
  };
}

describe('AgentRuntimeDriver — restart at every boundary', () => {
  const TERMINAL = new Set(['completed', 'failed', 'needs_attention', 'expired', 'canceled']);

  for (let boundary = 1; boundary <= 6; boundary += 1) {
    it(`crash after boundary ${boundary} resumes with no duplicate dispatch or message`, async () => {
      const base = new InMemoryAgentRunRepository();
      const runId = await seed(base, `boundary-${boundary}`);
      const repo = crashingRepo(base, boundary);
      const transport = new MockToolTransport();
      const service = makeService(repo, switchingProvider(), transport);

      // Runtime A runs until the injected crash (or to completion if boundary > writes).
      const driverA = new AgentRuntimeDriver({ repo, service, owner: 'rt-A' });
      try {
        await driverA.runToCompletion();
      } catch {
        // expected simulated crash at this boundary
      }

      // Runtime B resumes from the durable checkpoint and drives to a terminal state.
      const driverB = new AgentRuntimeDriver({ repo, service, owner: 'rt-B' });
      await driverB.drain();

      const run = base._run(runId)!;
      expect(TERMINAL.has(run.state)).toBe(true);

      // No duplicate final message.
      const assistants = base._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
      expect(assistants.length).toBeLessThanOrEqual(1);

      // No duplicate logical tool call: each dispatched id appears at most once.
      for (const id of new Set(transport.dispatched)) {
        expect(transport.countFor(id)).toBe(1);
      }
      // The single logical call is dispatched at most once total.
      expect(transport.dispatched.length).toBeLessThanOrEqual(1);
    });
  }
});

describe('AgentRuntimeDriver — two runtimes, stale fence', () => {
  it('rejects the stale runtime commit; exactly one advances', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'stale');
    const transport = new MockToolTransport();
    const service = makeService(repo, switchingProvider(), transport);

    // Runtime A claims with an already-expired lease (crashed mid-flight).
    const claimedA = await repo.claimQueuedAgentRun(
      'rt-A',
      new Date(),
      new Date(Date.now() - 5000),
    );
    expect(claimedA).not.toBeNull();

    // Runtime B claims the same run (fresh fence) and drives it to completion.
    const driverB = new AgentRuntimeDriver({ repo, service, owner: 'rt-B' });
    await driverB.drain();
    expect(repo._run(runId)!.state).toBe('completed');

    // Runtime A wakes and tries to advance with its STALE fence — must be rejected.
    const staleStep = await service.runStep(claimedA!);
    expect(staleStep.outcome).toBe('stale');

    // Still exactly one dispatch and one final message.
    expect(transport.dispatched.length).toBeLessThanOrEqual(1);
    expect(repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('AgentRuntimeDriver — invalid model response => NO dispatch', () => {
  async function runWith(
    provider: ModelProvider,
    key: string,
  ): Promise<{ run: RunRecord; transport: MockToolTransport }> {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, key);
    const transport = new MockToolTransport();
    const service = makeService(repo, provider, transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    return { run: repo._run(runId)!, transport };
  }

  it('malformed tool-call JSON throws in the gateway → needs_attention, no dispatch', async () => {
    const fixture: MockFixture = {
      id: 'bad-json',
      events: [
        { tool_call: { index: 0, id: 'c1', name: 'http.request', arguments: '{not json' } },
        { finish: 'tool_calls' },
      ],
    };
    const { run, transport } = await runWith(new MockProvider({ fixtures: [fixture] }), 'inv-json');
    expect(run.state).toBe('needs_attention');
    expect(run.stopReason).toBe('MODEL_OUTPUT_INVALID');
    expect(transport.dispatched).toHaveLength(0);
  });

  it('an unknown tool name → needs_attention, no dispatch', async () => {
    const provider = providerFrom(() => ({
      text: 'x',
      toolCalls: [{ id: 'c1', index: 0, name: 'no_such_tool', argumentsRaw: '{}', arguments: {} }],
      usage: { kind: 'unknown' },
      finishReason: 'tool_calls',
      isMock: true,
      providerLabel: 'MOCK — scripted',
    }));
    const { run, transport } = await runWith(provider, 'inv-tool');
    expect(run.state).toBe('needs_attention');
    expect(run.stopReason).toBe('UNKNOWN_TOOL');
    expect(transport.dispatched).toHaveLength(0);
  });

  it('schema-invalid tool arguments → needs_attention, no dispatch', async () => {
    const provider = providerFrom(() => toolResult({ host: 'x' })); // missing required fields
    const { run, transport } = await runWith(provider, 'inv-args');
    expect(run.state).toBe('needs_attention');
    expect(run.stopReason).toBe('MODEL_OUTPUT_INVALID');
    expect(transport.dispatched).toHaveLength(0);
  });

  it('a present-but-malformed plan block → needs_attention, no dispatch', async () => {
    const provider = providerFrom(() => finalResult('intro\n```redai:plan\n{bad json}\n```'));
    const { run, transport } = await runWith(provider, 'inv-plan');
    expect(run.state).toBe('needs_attention');
    expect(run.stopReason).toBe('MODEL_OUTPUT_INVALID');
    expect(transport.dispatched).toHaveLength(0);
  });
});

describe('AgentRuntimeDriver — authorization gate', () => {
  it('a denied tool is a blocked item with NO dispatch', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'deny');
    const transport = new MockToolTransport();
    const service = makeService(repo, switchingProvider(), transport, {
      authorizer: denyAllAuthorizer,
    });
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    const run = repo._run(runId)!;
    expect(run.state).toBe('needs_attention');
    expect(run.stopReason).toBe('POLICY_DENIED');
    expect(transport.dispatched).toHaveLength(0);
  });
});

describe('AgentRuntimeDriver — loop & limit termination', () => {
  it('detects a no-progress loop and fails with LOOP_DETECTED', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'loop');
    // Fixed result sha every dispatch → identical result → no progress.
    const transport = new MockToolTransport([
      { toolName: 'http.request', fixedResultSha: 'a'.repeat(64) },
    ]);
    const service = makeService(repo, alwaysToolProvider(), transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    const run = repo._run(runId)!;
    expect(run.state).toBe('failed');
    expect(run.stopReason).toBe('LOOP_DETECTED');
  });

  it('terminates with MAX_STEPS when the step cap is reached', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'steps', { maxSteps: 2 });
    // Distinct result sha per call so it is NOT a loop — the step cap must fire first.
    let n = 0;
    const transport = new MockToolTransport();
    const provider = providerFrom(() => toolResult({ ...VALID_HTTP, path: `/${(n += 1)}` }));
    const service = makeService(repo, provider, transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    const run = repo._run(runId)!;
    expect(run.state).toBe('failed');
    expect(run.stopReason).toBe('MAX_STEPS');
    expect(run.stepCount).toBeGreaterThanOrEqual(2);
  });

  it('terminates with ABSOLUTE_TIMEOUT (expired) past the absolute deadline', async () => {
    const repo = new InMemoryAgentRunRepository();
    const created = new Date('2026-01-01T00:00:00Z');
    const runId = await seed(repo, 'abs');
    // Backdate creation so the run is already past the 24h absolute deadline.
    const run = repo._run(runId)!;
    (run as { createdAt: Date }).createdAt = created;
    const transport = new MockToolTransport();
    const service = new AgentService({
      repo,
      context: emptyContext,
      provider: resolverFor(switchingProvider()),
      transport,
      authorizer: allowAllAuthorizer,
      clock: { now: () => new Date(created.getTime() + 86400 * 1000 + 1000) },
    });
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    expect(repo._run(runId)!.state).toBe('expired');
    expect(repo._run(runId)!.stopReason).toBe('ABSOLUTE_TIMEOUT');
    expect(transport.dispatched).toHaveLength(0);
  });

  it('terminates with ACTIVE_TIMEOUT once the active-time budget is spent', async () => {
    const repo = new InMemoryAgentRunRepository();
    const runId = await seed(repo, 'active');
    repo._patchCheckpoint(runId, { active_elapsed_ms: 1800 * 1000 });
    const transport = new MockToolTransport();
    const service = makeService(repo, switchingProvider(), transport);
    const driver = new AgentRuntimeDriver({ repo, service, owner: 'rt-1' });
    await driver.drain();
    const run = repo._run(runId)!;
    expect(run.state).toBe('failed');
    expect(run.stopReason).toBe('ACTIVE_TIMEOUT');
    expect(transport.dispatched).toHaveLength(0);
  });
});

/**
 * Unit tests for the durable Ask runtime driver against the in-memory repository. The
 * driver's job is the lease lifecycle — claim → step → release — and recovery of a
 * run left running with an expired lease; the step itself (provider round-trip,
 * partial/final persistence, generation guard) is proven end-to-end against the mock
 * provider in `packages/application/src/messages/service.test.ts`.
 *
 * The injected `runStep` here simulates that step by driving the repository's
 * fence-guarded begin/finalize, so this test needs no model provider and depends only
 * on `@redai/application/messages`.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryMessagesRepository, canonicalBodyHash } from '@redai/application/messages';
import type { ClaimedRun, StepResult } from '@redai/application/messages';
import { AskRuntimeDriver } from './driver.js';

const WS = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const CHAT = '00000000-0000-4000-8000-000000000003';
const PROVIDER = '00000000-0000-4000-8000-000000000004';

let msgCounter = 0;
function nextMsgId(): string {
  msgCounter += 1;
  return `00000000-0000-4000-8000-${String(msgCounter).padStart(12, '0')}`;
}

/** A step that begins the provisional message then finalizes it — fence-guarded. */
function fakeStep(repo: InMemoryMessagesRepository, text: string) {
  return async (claimed: ClaimedRun): Promise<StepResult> => {
    const run = claimed.run;
    const existing =
      typeof run.checkpoint['assistant_message_id'] === 'string'
        ? (run.checkpoint['assistant_message_id'] as string)
        : nextMsgId();
    const begin = await repo.beginAssistantMessage({
      runId: run.id,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      chatId: run.chatId,
      expectedFence: claimed.fence,
      assistantMessageId: existing,
      now: new Date(),
    });
    if (begin.result === 'stale') return { runId: run.id, outcome: 'stale' };
    const finalized = await repo.finalizeAssistant({
      runId: run.id,
      workspaceId: run.workspaceId,
      assistantMessageId: begin.assistantMessageId,
      expectedFence: claimed.fence,
      text,
      sha256: 'sha',
      generationId: claimed.fence,
      providerLabel: 'MOCK — scripted (not a real model)',
      isMock: true,
      usage: { kind: 'unknown' },
      finishReason: 'stop',
      now: new Date(),
    });
    if (finalized === 'stale') return { runId: run.id, outcome: 'stale' };
    return { runId: run.id, outcome: 'completed', assistantMessageId: begin.assistantMessageId };
  };
}

async function seed(repo: InMemoryMessagesRepository, key: string): Promise<string> {
  const out = await repo.createAskRun({
    workspaceId: WS,
    projectId: PROJECT,
    chatId: CHAT,
    runId: nextMsgId(),
    userMessageId: nextMsgId(),
    providerConfigId: PROVIDER,
    text: 'hello?',
    clientMessageId: nextMsgId(),
    attachedArtifactIds: [],
    dataMode: 'redacted_cloud',
    budgetLimitMicroUsd: '2000000',
    maxSteps: 40,
    expiresAt: new Date(Date.now() + 86400000),
    now: new Date(),
    idempotency: {
      workspaceId: WS,
      actorKey: 'owner',
      method: 'POST',
      route: '/r',
      key,
      bodySha256: canonicalBodyHash({ key }),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  if (out.kind !== 'created') throw new Error(`expected created, got ${out.kind}`);
  return out.run.id;
}

function makeDriver(repo: InMemoryMessagesRepository, text: string, owner = 'runtime-test') {
  return new AskRuntimeDriver({ repo, runStep: fakeStep(repo, text), owner, leaseSeconds: 60 });
}

describe('AskRuntimeDriver.tickOnce', () => {
  it('claims a queued Ask run, runs the step, and completes it', async () => {
    const repo = new InMemoryMessagesRepository();
    const runId = await seed(repo, 'k1');
    const driver = makeDriver(repo, 'the answer');

    const result = await driver.tickOnce();
    expect(result.claimed).toBe(true);
    expect(result.runId).toBe(runId);
    expect(result.step?.outcome).toBe('completed');
    expect(repo._run(runId)!.state).toBe('completed');
    const assistants = repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe('the answer');
  });

  it('returns { claimed: false } when there is nothing to do', async () => {
    const repo = new InMemoryMessagesRepository();
    const driver = makeDriver(repo, 'x');
    expect(await driver.tickOnce()).toEqual({ claimed: false });
  });

  it('a completed Ask is final: a second tick does not re-claim it', async () => {
    const repo = new InMemoryMessagesRepository();
    await seed(repo, 'k2');
    const driver = makeDriver(repo, 'done');
    await driver.tickOnce();
    const second = await driver.tickOnce();
    expect(second.claimed).toBe(false);
    expect(repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('AskRuntimeDriver lease-expiry recovery', () => {
  it('recovers a run left running with an expired lease without duplicating the reply', async () => {
    const repo = new InMemoryMessagesRepository();
    const runId = await seed(repo, 'k3');
    const driver = makeDriver(repo, 'recovered answer');

    // Simulate a crashed runtime: claim, begin the partial, leave the lease expired.
    const claimed = await repo.claimQueuedAskRun(
      'dead-runtime',
      new Date(),
      new Date(Date.now() - 5000),
    );
    await repo.beginAssistantMessage({
      runId,
      workspaceId: WS,
      projectId: PROJECT,
      chatId: CHAT,
      expectedFence: claimed!.fence,
      assistantMessageId: nextMsgId(),
      now: new Date(),
    });
    expect(repo._run(runId)!.state).toBe('running');

    const result = await driver.tickOnce();
    expect(result.claimed).toBe(true);
    expect(result.runId).toBe(runId);
    expect(result.step?.outcome).toBe('completed');

    const assistants = repo._messagesForChat(CHAT).filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.status).toBe('completed');
    expect(assistants[0]!.textContent).toBe('recovered answer');
  });
});

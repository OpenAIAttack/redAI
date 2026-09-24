// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatRun } from './useChatRun';
import { MockEventSource, mockEventSourceFactory } from './mockEventSource';

/**
 * End-to-end (mocked) controller test: `send` creates exactly ONE run, the reply
 * streams provisional → committed, and a reconnect reloads the snapshot WITHOUT
 * creating a new run or wiping the transcript.
 */
const PROJECT = '10000000-0000-4000-8000-000000000002';
const CHAT = '10000000-0000-4000-8000-000000000003';
const RUN = '10000000-0000-4000-8000-000000000004';
const PROVIDER = '10000000-0000-4000-8000-000000000005';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runStatus(state: string) {
  return {
    id: RUN,
    workspace_id: 'ws',
    project_id: PROJECT,
    chat_id: CHAT,
    mode: 'ask',
    kind: 'ask',
    state,
    outcome: null,
    provider_config_id: PROVIDER,
    step_count: 0,
    budget_limit_micro_usd: '5000000',
    stop_reason: null,
    expires_at: '2026-09-24T01:00:00Z',
    revision: 1,
    created_at: '2026-09-24T00:00:00Z',
    updated_at: '2026-09-24T00:00:00Z',
  };
}

function userMessageDto() {
  return {
    id: 'srv-user-1',
    chat_id: CHAT,
    run_id: RUN,
    seq: 0,
    role: 'user',
    text: 'hello?',
    status: 'completed',
    artifact_ids: [],
    created_at: '2026-09-24T00:00:00Z',
  };
}

function envelope(type: string, eventId: string, data: unknown) {
  return {
    schema_version: '1.0',
    event_id: eventId,
    workspace_id: 'ws',
    project_id: PROJECT,
    run_id: RUN,
    type,
    created_at: '2026-09-24T00:00:00Z',
    data,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let postCount = 0;

beforeEach(() => {
  MockEventSource.instances = [];
  postCount = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/runs')) {
      postCount += 1;
      return json(201, { run: runStatus('running'), message: userMessageDto() });
    }
    if (url.includes('/messages')) {
      return json(200, { items: [] }); // durable history (empty; transcript is live)
    }
    if (url.includes(`/runs/${RUN}`)) {
      return json(200, runStatus('running'));
    }
    return json(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'cookie', { writable: true, value: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function firstEs(): MockEventSource {
  const es = MockEventSource.instances[0];
  if (!es) throw new Error('no EventSource opened');
  return es;
}

describe('useChatRun', () => {
  it('send → one run, streaming reply, provisional promoted once on commit', async () => {
    const { result } = renderHook(() =>
      useChatRun(PROJECT, CHAT, { eventSourceFactory: mockEventSourceFactory() }),
    );
    await waitFor(() => expect(result.current.loadingHistory).toBe(false));

    await act(async () => {
      await result.current.send({ text: 'hello?', providerConfigId: PROVIDER });
    });

    expect(postCount).toBe(1);
    expect(result.current.runActive).toBe(true);
    // Optimistic user bubble reconciled to the durable id.
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);

    // The SSE connection is opened for the active run.
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    const es = firstEs();
    act(() => es.open());

    // Stream two deltas → one provisional bubble.
    act(() => {
      es.emit(
        envelope('message.delta', '10', {
          message_id: 'asst-1',
          generation_id: 'gen-1',
          delta_seq: '1',
          text: 'Hi ',
          provisional: true,
        }),
      );
      es.emit(
        envelope('message.delta', '11', {
          message_id: 'asst-1',
          generation_id: 'gen-1',
          delta_seq: '2',
          text: 'there',
          provisional: true,
        }),
      );
    });

    let assistant = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe('Hi there');
    expect(assistant[0]!.provisional).toBe(true);

    // Commit promotes the SAME bubble exactly once.
    act(() => {
      es.emit(
        envelope('message.committed', '12', {
          message_id: 'asst-1',
          sha256: 'a'.repeat(64),
          status: 'completed',
        }),
      );
    });
    assistant = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.provisional).toBe(false);
    expect(assistant[0]!.status).toBe('completed');
  });

  it('reconnect does NOT create a run and does NOT wipe history', async () => {
    const { result } = renderHook(() =>
      useChatRun(PROJECT, CHAT, { eventSourceFactory: mockEventSourceFactory() }),
    );
    await waitFor(() => expect(result.current.loadingHistory).toBe(false));

    await act(async () => {
      await result.current.send({ text: 'hello?', providerConfigId: PROVIDER });
    });
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    const es = firstEs();
    act(() => es.open());
    act(() => {
      es.emit(
        envelope('message.delta', '10', {
          message_id: 'asst-1',
          generation_id: 'gen-1',
          delta_seq: '1',
          text: 'answer',
          provisional: true,
        }),
      );
    });
    expect(postCount).toBe(1);
    const beforeCount = result.current.messages.length;
    expect(beforeCount).toBeGreaterThan(0);

    // Reconnect: fires onResync → reload snapshot (GET only). No new run.
    await act(async () => {
      es.reconnect();
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(postCount).toBe(1); // still exactly one run created
    expect(result.current.messages.length).toBeGreaterThanOrEqual(beforeCount); // not wiped
    // A duplicated delta after reconnect is deduped by event_id (no doubling).
    act(() => {
      es.emit(
        envelope('message.delta', '10', {
          message_id: 'asst-1',
          generation_id: 'gen-1',
          delta_seq: '1',
          text: 'answer',
          provisional: true,
        }),
      );
    });
    const assistant = result.current.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe('answer');
  });
});

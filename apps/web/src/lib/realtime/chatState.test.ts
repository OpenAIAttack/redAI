import { describe, it, expect } from 'vitest';
import { chatReducer, initialChatState, compareCounter, type ChatState } from './chatState';
import type { EventEnvelope, Message, MessageCommittedEvent, MessageDeltaEvent } from '../types';

/**
 * The transcript state machine carries T10b's hard invariants. These tests pin
 * them down without React: dedup by event_id, provisional deltas accumulating into
 * one bubble that a commit promotes exactly once, object-identity stability for a
 * long transcript, and reconnect that merges history rather than wiping it.
 */

function baseEnv(overrides: Partial<EventEnvelope> & { type: string }): EventEnvelope {
  return {
    schema_version: '1.0',
    event_id: '1',
    workspace_id: 'ws',
    project_id: 'proj',
    run_id: 'run-1',
    created_at: '2026-09-24T00:00:00Z',
    data: {},
    ...overrides,
  } as EventEnvelope;
}

function delta(
  eventId: string,
  deltaSeq: string,
  text: string,
  ids: { gen?: string; msg?: string } = {},
): MessageDeltaEvent {
  return baseEnv({
    type: 'message.delta',
    event_id: eventId,
    data: {
      message_id: ids.msg ?? 'msg-1',
      generation_id: ids.gen ?? 'gen-1',
      delta_seq: deltaSeq,
      text,
      provisional: true,
    },
  }) as MessageDeltaEvent;
}

function committed(eventId: string, msg = 'msg-1'): MessageCommittedEvent {
  return baseEnv({
    type: 'message.committed',
    event_id: eventId,
    data: { message_id: msg, sha256: 'a'.repeat(64), status: 'completed' },
  }) as MessageCommittedEvent;
}

function serverMsg(over: Partial<Message> & { id: string; seq: number }): Message {
  return {
    chat_id: 'chat-1',
    run_id: 'run-1',
    role: 'user',
    text: '',
    status: 'completed',
    artifact_ids: [],
    created_at: '2026-09-24T00:00:00Z',
    ...over,
  };
}

function apply(state: ChatState, env: EventEnvelope): ChatState {
  return chatReducer(state, { kind: 'event', envelope: env });
}

describe('chatReducer — dedup by event_id', () => {
  it('ignores a redelivered delta (same event_id) so text is not doubled', () => {
    let s = initialChatState();
    s = apply(s, delta('10', '1', 'Hello'));
    s = apply(s, delta('10', '1', 'Hello')); // redelivery, same event_id
    const assistant = s.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe('Hello');
    // Activity log also does not double-count the event.
    expect(s.activity.filter((a) => a.eventId === '10')).toHaveLength(1);
  });
});

describe('chatReducer — provisional vs final', () => {
  it('accumulates deltas into ONE bubble then a commit promotes it exactly once', () => {
    let s = initialChatState();
    s = apply(s, delta('1', '1', 'Hel'));
    s = apply(s, delta('2', '2', 'lo, '));
    s = apply(s, delta('3', '3', 'world'));

    let assistant = s.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.text).toBe('Hel' + 'lo, ' + 'world');
    expect(assistant[0]!.provisional).toBe(true);
    expect(assistant[0]!.status).toBe('streaming');

    s = apply(s, committed('4'));
    assistant = s.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1); // NOT a second bubble
    expect(assistant[0]!.provisional).toBe(false);
    expect(assistant[0]!.status).toBe('completed');
    expect(assistant[0]!.text).toBe('Hello, world');
    expect(assistant[0]!.key).toBe('msg-1'); // stabilised to durable id
  });

  it('requests a resync when a commit arrives with no provisional bubble', () => {
    let s = initialChatState();
    s = apply(s, committed('7', 'msg-unknown'));
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(s.resyncRequested).toBe(true);
  });

  it('drops an out-of-order / replayed delta_seq', () => {
    let s = initialChatState();
    s = apply(s, delta('1', '2', 'B'));
    s = apply(s, delta('2', '1', 'A')); // lower delta_seq, different event_id
    const a = s.messages.filter((m) => m.role === 'assistant')[0]!;
    expect(a.text).toBe('B');
  });
});

describe('chatReducer — object identity (no O(n) re-render on a delta)', () => {
  it('preserves references of all untouched messages when a delta lands', () => {
    let s = initialChatState();
    // A long committed history.
    const history: Message[] = [];
    for (let i = 0; i < 200; i += 1) {
      history.push(
        serverMsg({
          id: `m${i}`,
          seq: i,
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: `msg ${i}`,
        }),
      );
    }
    s = chatReducer(s, { kind: 'history', messages: history });
    // Start a streaming reply.
    s = apply(s, delta('1000', '1', 'x'));
    const before = s.messages.slice();

    s = apply(s, delta('1001', '2', 'y')); // one more token

    // Every prior message object is the SAME reference; only the streaming bubble changed.
    for (let i = 0; i < before.length - 1; i += 1) {
      expect(s.messages[i]).toBe(before[i]);
    }
    const streaming = s.messages[s.messages.length - 1]!;
    expect(streaming).not.toBe(before[before.length - 1]);
    expect(streaming.text).toBe('xy');
  });
});

describe('chatReducer — reconnect merges history, never wipes or creates a run', () => {
  it('applyHistory preserves messages and does not set an active run', () => {
    let s = initialChatState();
    const history = [
      serverMsg({ id: 'u1', seq: 0, role: 'user', text: 'hi' }),
      serverMsg({ id: 'a1', seq: 1, role: 'assistant', text: 'hello', status: 'completed' }),
    ];
    s = chatReducer(s, { kind: 'history', messages: history });
    expect(s.messages).toHaveLength(2);
    expect(s.activeRunId).toBeNull();

    // A reconnect resync re-applies the same snapshot.
    const s2 = chatReducer(s, { kind: 'history', messages: history });
    expect(s2.messages).toHaveLength(2); // not wiped, not duplicated
    expect(s2.activeRunId).toBeNull(); // reconnect never creates a run
    // Unchanged messages keep identity across the merge.
    expect(s2.messages[0]).toBe(s.messages[0]);
    expect(s2.messages[1]).toBe(s.messages[1]);
  });

  it('keeps an in-flight optimistic bubble across a resync, then reconciles it', () => {
    let s = initialChatState();
    s = chatReducer(s, {
      kind: 'optimistic-user',
      clientMessageId: 'c1',
      text: 'question',
      artifactIds: [],
    });
    // Resync arrives before the server persisted the message.
    s = chatReducer(s, { kind: 'history', messages: [] });
    expect(s.messages).toHaveLength(1); // optimistic bubble not wiped
    expect(s.messages[0]!.id).toBeNull();

    // run-created reconciles the optimistic bubble to the durable id.
    s = chatReducer(s, {
      kind: 'run-created',
      runId: 'run-9',
      clientMessageId: 'c1',
      userMessage: serverMsg({ id: 'srv1', seq: 0, role: 'user', text: 'question' }),
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.id).toBe('srv1');
    expect(s.activeRunId).toBe('run-9');
  });

  it('clears the active run on a terminal run.state_changed', () => {
    let s = initialChatState();
    s = chatReducer(s, { kind: 'run-status', runId: 'run-1', state: 'running' });
    expect(s.activeRunId).toBe('run-1');
    s = apply(
      s,
      baseEnv({
        type: 'run.state_changed',
        event_id: '5',
        data: { from: 'running', to: 'completed', reason_code: null },
      }),
    );
    expect(s.runState).toBe('completed');
    expect(s.activeRunId).toBeNull();
  });
});

describe('compareCounter', () => {
  it('orders decimal-string counters numerically, not lexically', () => {
    expect(compareCounter('9', '10')).toBeLessThan(0);
    expect(compareCounter('10', '9')).toBeGreaterThan(0);
    expect(compareCounter('7', '7')).toBe(0);
  });
});

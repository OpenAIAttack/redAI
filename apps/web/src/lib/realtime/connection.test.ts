// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { RealtimeConnection } from './connection';
import { MockEventSource, mockEventSourceFactory } from './mockEventSource';
import type { EventEnvelope } from '../types';

/**
 * The EventSource wrapper: it dispatches parsed envelopes, treats a reconnect (a
 * second `open`) and a `resync` frame and a hard close as resync signals, and ends
 * cleanly on close. The native EventSource resends Last-Event-ID itself, so there
 * is nothing to assert about headers here.
 */
beforeEach(() => {
  MockEventSource.instances = [];
});

function connect(handlers: {
  onEvent?: (e: EventEnvelope) => void;
  onResync?: () => void;
  onOpen?: () => void;
}): { conn: RealtimeConnection; es: MockEventSource } {
  const conn = new RealtimeConnection(
    { projectId: 'p1', runId: 'r1' },
    {
      onEvent: handlers.onEvent ?? (() => {}),
      onResync: handlers.onResync ?? (() => {}),
      ...(handlers.onOpen ? { onOpen: handlers.onOpen } : {}),
    },
    mockEventSourceFactory(),
  );
  const es = MockEventSource.instances[0]!;
  return { conn, es };
}

describe('RealtimeConnection', () => {
  it('builds a scoped, credentialed URL', () => {
    const { es } = connect({});
    expect(es.url).toContain('/api/v1/events?');
    expect(es.url).toContain('project_id=p1');
    expect(es.url).toContain('run_id=r1');
    expect(es.init.withCredentials).toBe(true);
  });

  it('dispatches a parsed envelope from a message frame', () => {
    const events: EventEnvelope[] = [];
    const { es } = connect({ onEvent: (e) => events.push(e) });
    es.open();
    es.emit({
      schema_version: '1.0',
      event_id: '5',
      workspace_id: 'ws',
      project_id: 'p1',
      run_id: 'r1',
      type: 'run.state_changed',
      created_at: 'now',
      data: { from: 'queued', to: 'running', reason_code: null },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe('5');
    expect(events[0]!.type).toBe('run.state_changed');
  });

  it('the FIRST open is not a resync; a later open (reconnect) IS', () => {
    let opens = 0;
    let resyncs = 0;
    const { es } = connect({ onOpen: () => (opens += 1), onResync: () => (resyncs += 1) });
    es.open();
    expect(opens).toBe(1);
    expect(resyncs).toBe(0);
    es.reconnect();
    expect(resyncs).toBe(1); // reconnect reloads the snapshot
  });

  it('treats a `resync` frame as a resync signal', () => {
    let resyncs = 0;
    const { es } = connect({ onResync: () => (resyncs += 1) });
    es.open();
    es.emitRaw('resync', 'resync');
    expect(resyncs).toBe(1);
  });

  it('treats a hard close (CLOSED) as a resync signal', () => {
    let resyncs = 0;
    const { es } = connect({ onResync: () => (resyncs += 1) });
    es.open();
    es.errorClosed();
    expect(resyncs).toBe(1);
  });

  it('ignores frames after close()', () => {
    const events: EventEnvelope[] = [];
    const { conn, es } = connect({ onEvent: (e) => events.push(e) });
    es.open();
    conn.close();
    es.emit({ event_id: '9', type: 'message.committed', data: {} });
    expect(events).toHaveLength(0);
  });
});

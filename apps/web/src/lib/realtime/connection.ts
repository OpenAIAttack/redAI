/**
 * Typed EventSource wrapper for the workspace event stream (docs/06 §7-9).
 *
 * The browser's native EventSource does the hard parts for us: it automatically
 * resends `Last-Event-ID` (the last `id:` it saw) on reconnect, so we never build
 * a header by hand, and it ignores SSE comment heartbeats. We add:
 *
 *  - Same-origin, cookie-authenticated connection (`withCredentials`) scoped to a
 *    project + run, so the stream only carries this run's events.
 *  - A single raw handler registered for the default `message` event, an explicit
 *    `resync` event, and every envelope `type` we might receive as a NAMED SSE
 *    event — whichever the server uses, exactly one listener fires per frame and
 *    dispatch is driven by the envelope's own `type` field.
 *  - Reconnect handling: a reconnect (a second `open`, or the stream closing) is a
 *    `resync` signal — reload the snapshot and let dedup absorb replays. We NEVER
 *    create a run or clear state here.
 *
 * The EventSource constructor is injected so tests can supply a mock; in the
 * browser it defaults to the global.
 */
import type { EventEnvelope } from '../types';

export type EventSourceFactory = (url: string, init: { withCredentials: boolean }) => EventSource;

export interface RealtimeHandlers {
  onEvent: (env: EventEnvelope) => void;
  /** Reconnect or explicit resync: caller reloads history + run status. */
  onResync: () => void;
  onOpen?: () => void;
  onError?: (err: Event) => void;
}

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

/** EventSource.readyState === CLOSED (WHATWG constant; avoids a global reference). */
const READY_STATE_CLOSED = 2;

/** Envelope types that may arrive as NAMED SSE events (superset is harmless). */
const NAMED_EVENT_TYPES = [
  'run.created',
  'run.state_changed',
  'message.delta',
  'message.committed',
  'plan.updated',
  'budget.updated',
  'approval.requested',
  'approval.decided',
  'tool.state_changed',
  'worker.state_changed',
  'artifact.ready',
  'finding.updated',
  'grant.revoked',
  'report.ready',
  'stream.cursor',
];

function isEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['event_id'] === 'string' && typeof v['type'] === 'string' && 'data' in v;
}

export class RealtimeConnection {
  private readonly source: EventSource;
  private opened = false;
  private closed = false;

  constructor(
    params: { projectId: string; runId: string },
    private readonly handlers: RealtimeHandlers,
    factory?: EventSourceFactory,
  ) {
    const make: EventSourceFactory = factory ?? ((url, init) => new EventSource(url, init));

    const qs = new URLSearchParams({
      project_id: params.projectId,
      run_id: params.runId,
    });
    this.source = make(`${BASE}/api/v1/events?${qs.toString()}`, { withCredentials: true });

    const raw = (evt: MessageEvent): void => this.handleRaw(evt);
    this.source.addEventListener('message', raw as EventListener);
    this.source.addEventListener('resync', (() => this.handlers.onResync()) as EventListener);
    for (const type of NAMED_EVENT_TYPES) {
      this.source.addEventListener(type, raw as EventListener);
    }

    this.source.onopen = (): void => {
      if (this.closed) return;
      if (this.opened) {
        // A reconnect happened: reload the snapshot (dedup absorbs replays).
        this.handlers.onResync();
      } else {
        this.opened = true;
        this.handlers.onOpen?.();
      }
    };

    this.source.onerror = (err: Event): void => {
      if (this.closed) return;
      this.handlers.onError?.(err);
      // If the browser gave up (CLOSED), the stream is gone: treat as resync so the
      // caller reloads state. If it is reconnecting (CONNECTING), the `open` above
      // will fire the resync once the connection is back.
      if (this.source.readyState === READY_STATE_CLOSED) {
        this.handlers.onResync();
      }
    };
  }

  private handleRaw(evt: MessageEvent): void {
    if (this.closed) return;
    const data = typeof evt.data === 'string' ? evt.data : '';
    if (!data) return;
    if (data === 'resync') {
      this.handlers.onResync();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // ignore malformed frame
    }
    if ((parsed as { type?: unknown } | null)?.type === 'resync') {
      this.handlers.onResync();
      return;
    }
    if (isEnvelope(parsed)) {
      this.handlers.onEvent(parsed);
    }
  }

  close(): void {
    this.closed = true;
    this.source.close();
  }
}

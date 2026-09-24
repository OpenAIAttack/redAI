/**
 * A tiny in-memory EventSource stand-in for unit/component tests (no real network,
 * no browser). It records instances so a test can drive open / message / reconnect
 * / error transitions deterministically. Not shipped — imported only by *.test.ts.
 */
import type { EventSourceFactory } from './connection';

type Listener = (evt: MessageEvent) => void;

export class MockEventSource {
  static instances: MockEventSource[] = [];

  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly init: { withCredentials: boolean },
  ) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(cb as unknown as Listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // --- test drivers ---------------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Deliver a JSON envelope as an SSE `message` frame. */
  emit(envelope: unknown): void {
    const evt = new MessageEvent('message', { data: JSON.stringify(envelope) });
    const set = this.listeners.get('message');
    if (set) for (const cb of set) cb(evt);
    this.onmessage?.(evt);
  }

  /** Deliver a raw string frame (e.g. `resync`). */
  emitRaw(data: string, type = 'message'): void {
    const evt = new MessageEvent(type, { data });
    const set = this.listeners.get(type);
    if (set) for (const cb of set) cb(evt);
  }

  /** Simulate the browser reconnecting (fires open again). */
  reconnect(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Simulate the stream closing for good. */
  errorClosed(): void {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

export function mockEventSourceFactory(): EventSourceFactory {
  return (url, init) => new MockEventSource(url, init) as unknown as EventSource;
}

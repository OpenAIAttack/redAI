/**
 * SseSession unit tests (no socket): frame shape and the slow-consumer backpressure
 * bound. A fake writer that never drains lets the overflow path be asserted
 * deterministically, without racing a real TCP buffer.
 */
import { describe, expect, it } from 'vitest';
import { SseSession, type SseWriter } from './sse.js';

/** A writer that buffers forever (never drains) — models a stalled consumer. */
class StalledWriter implements SseWriter {
  public chunks: string[] = [];
  public destroyed = false;
  public writableEnded = false;
  public get writableLength(): number {
    return this.chunks.join('').length;
  }
  public write(chunk: string): boolean {
    if (this.destroyed) throw new Error('write after destroy');
    this.chunks.push(chunk);
    return false; // always backpressured
  }
  public end(): void {
    this.writableEnded = true;
  }
  public destroy(): void {
    this.destroyed = true;
  }
  public get text(): string {
    return this.chunks.join('');
  }
}

describe('SseSession framing', () => {
  it('emits an id + event + data frame terminated by a blank line', () => {
    const w = new StalledWriter();
    const s = new SseSession(w, { maxBufferBytes: 1_000_000 });
    s.sendEvent('42', 'run.created', '{"a":1}');
    expect(w.text).toBe('id: 42\nevent: run.created\ndata: {"a":1}\n\n');
  });

  it('resync frames carry no id: (Last-Event-ID must not move)', () => {
    const w = new StalledWriter();
    const s = new SseSession(w, { maxBufferBytes: 1_000_000 });
    s.sendResync('cursor_expired');
    expect(w.text).toBe('event: stream.resync\ndata: {"reason":"cursor_expired"}\n\n');
  });
});

describe('SseSession backpressure', () => {
  it('drops a stalled consumer past the buffer bound with a resync signal, not OOM', () => {
    const w = new StalledWriter();
    const s = new SseSession(w, { maxBufferBytes: 64 }); // tiny bound
    const payload = JSON.stringify({ text: 'x'.repeat(200) });

    let sent = 0;
    for (let i = 0; i < 100; i += 1) {
      if (!s.sendEvent(String(i), 'message.delta', payload)) break;
      sent += 1;
    }

    expect(s.overflowed).toBe(true);
    expect(s.closed).toBe(true);
    expect(w.destroyed).toBe(true);
    // It closed quickly rather than buffering all 100 frames unbounded.
    expect(sent).toBeLessThan(3);
    expect(w.text).toContain('event: stream.resync');
    expect(w.text).toContain('slow_consumer');
  });

  it('further writes after overflow are refused', () => {
    const w = new StalledWriter();
    const s = new SseSession(w, { maxBufferBytes: 8 });
    s.sendEvent('1', 'x', '"aaaaaaaaaaaaaaaa"');
    expect(s.overflowed).toBe(true);
    expect(s.heartbeat()).toBe(false);
    expect(s.sendEvent('2', 'x', 'y')).toBe(false);
  });
});

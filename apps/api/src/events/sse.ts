/**
 * SSE frame writer with bounded outbound backpressure (T11).
 *
 * `SseSession` wraps the minimal writable surface of a Node `http.ServerResponse`
 * (which `reply.raw` is). It is deliberately transport-only and synchronous so it can
 * be unit-tested with a fake writer: the DB-backed suites drive real sockets, and a
 * fake writer that never drains proves the slow-consumer path deterministically.
 *
 * Backpressure (docs/06 §7): a stalled consumer's frames pile up in the socket's own
 * write buffer. After every write we check `writableLength`; once the buffered bytes
 * exceed `maxBufferBytes` the session is OVERFLOWED — we make a best-effort resync
 * frame and destroy the socket rather than letting memory grow unbounded. The client
 * then reconnects and replays from its `Last-Event-ID` (or fetches a snapshot).
 */

/** The subset of `http.ServerResponse` the session needs. */
export interface SseWriter {
  write(chunk: string): boolean;
  end(): void;
  destroy(error?: Error): void;
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
}

export type ResyncReason = 'cursor_expired' | 'slow_consumer';

export interface SseSessionOptions {
  /** Hard cap on buffered outbound bytes before the slow consumer is dropped. */
  maxBufferBytes: number;
}

/** One line of SSE `data:`. Envelopes are single-line JSON, but be defensive. */
function dataLines(payload: string): string {
  if (!payload.includes('\n')) return `data: ${payload}\n`;
  return payload
    .split('\n')
    .map((line) => `data: ${line}\n`)
    .join('');
}

export class SseSession {
  private readonly writer: SseWriter;
  private readonly maxBufferBytes: number;
  private overflowedFlag = false;
  private closedFlag = false;

  public constructor(writer: SseWriter, options: SseSessionOptions) {
    this.writer = writer;
    this.maxBufferBytes = options.maxBufferBytes;
  }

  /** True once the socket has been closed or dropped from either side. */
  public get closed(): boolean {
    return this.closedFlag || this.writer.destroyed || this.writer.writableEnded;
  }

  /** True once the slow-consumer bound was hit and the socket was dropped. */
  public get overflowed(): boolean {
    return this.overflowedFlag;
  }

  /**
   * Write a raw chunk, then enforce the buffer bound. Returns false when the write
   * could not be made (already closed) or tripped the bound (now overflowed+closed).
   */
  private rawWrite(chunk: string): boolean {
    if (this.closed) return false;
    try {
      this.writer.write(chunk);
    } catch {
      this.closedFlag = true;
      return false;
    }
    if (this.writer.writableLength > this.maxBufferBytes) {
      this.tripOverflow();
      return false;
    }
    return true;
  }

  private tripOverflow(): void {
    if (this.overflowedFlag) return;
    this.overflowedFlag = true;
    // Best-effort resync hint; may not flush past a full buffer, but the disconnect
    // itself triggers the client's reconnect either way.
    try {
      this.writer.write(`event: stream.resync\ndata: {"reason":"slow_consumer"}\n\n`);
    } catch {
      /* ignore: we are tearing the socket down regardless */
    }
    try {
      this.writer.destroy();
    } catch {
      /* ignore */
    }
    this.closedFlag = true;
  }

  /** SSE comment used as a heartbeat/keep-alive. */
  public heartbeat(): boolean {
    return this.rawWrite(`: heartbeat\n\n`);
  }

  /** Suggest the client's auto-reconnect delay (ms). */
  public retryHint(ms: number): boolean {
    return this.rawWrite(`retry: ${ms}\n\n`);
  }

  /** Opening comment so proxies flush headers and the stream is visibly live. */
  public open(): boolean {
    return this.rawWrite(`: connected\n\n`);
  }

  /**
   * Emit a journal (or `stream.cursor`) event. `id` sets the SSE `id:` so the
   * browser's `Last-Event-ID` advances for replay/dedup on reconnect.
   */
  public sendEvent(id: string, type: string, payloadJson: string): boolean {
    return this.rawWrite(`id: ${id}\nevent: ${type}\n${dataLines(payloadJson)}\n`);
  }

  /**
   * Emit a transport-level resync control frame. This is NOT a journal event (it has
   * no `id:`, so it never moves `Last-Event-ID`); it tells the client to discard local
   * stream state and resync from a snapshot. Used for an expired cursor before any
   * events, and best-effort on slow-consumer overflow.
   */
  public sendResync(reason: ResyncReason): boolean {
    return this.rawWrite(`event: stream.resync\ndata: {"reason":"${reason}"}\n\n`);
  }

  /** End the response cleanly (no more frames). */
  public end(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try {
      if (!this.writer.writableEnded && !this.writer.destroyed) this.writer.end();
    } catch {
      /* ignore */
    }
  }
}

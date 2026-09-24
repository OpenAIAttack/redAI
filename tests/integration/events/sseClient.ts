/**
 * A tiny SSE client over raw `http` for the T11 integration suite. It can send a
 * `Last-Event-ID` header (reconnect), parse `id:`/`event:`/`data:` frames and comments
 * incrementally, wait for frames matching a predicate, and pause its socket to model a
 * stalled (backpressured) consumer.
 */
import http from 'node:http';

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

export interface SseClientOptions {
  lastEventId?: string;
  headers?: Record<string, string>;
  /** Do not read the socket (models a stalled consumer that never drains). */
  pause?: boolean;
}

export class SseClient {
  public readonly frames: SseFrame[] = [];
  public statusCode = 0;
  public ended = false;
  public error: Error | null = null;

  private req: http.ClientRequest | null = null;
  private res: http.IncomingMessage | null = null;
  private buffer = '';
  private waiters: Array<() => void> = [];

  public constructor(
    private readonly baseUrl: string,
    private readonly path: string,
    private readonly options: SseClientOptions = {},
  ) {}

  public connect(): Promise<void> {
    const url = new URL(this.path, this.baseUrl);
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...this.options.headers,
    };
    if (this.options.lastEventId !== undefined) headers['Last-Event-ID'] = this.options.lastEventId;

    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'GET',
          headers,
        },
        (res) => {
          this.res = res;
          this.statusCode = res.statusCode ?? 0;
          res.setEncoding('utf8');
          if (this.options.pause) res.pause();
          res.on('data', (chunk: string) => this.onData(chunk));
          res.on('end', () => this.finish());
          res.on('close', () => this.finish());
          res.on('error', (err) => {
            this.error = err;
            this.finish();
          });
          resolve();
        },
      );
      req.on('error', (err) => {
        this.error = err;
        this.finish();
        reject(err);
      });
      req.end();
      this.req = req;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // Frames are separated by a blank line.
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.dispatch(block);
    }
  }

  private dispatch(block: string): void {
    const frame: SseFrame = {};
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        frame.comment = (frame.comment ?? '') + line.slice(1).trim();
      } else if (line.startsWith('id:')) {
        frame.id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        frame.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length) frame.data = dataLines.join('\n');
    this.frames.push(frame);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Data frames only (skip comments/heartbeats). */
  public get events(): SseFrame[] {
    return this.frames.filter((f) => f.event !== undefined || f.data !== undefined);
  }

  /** Wait until `predicate` holds over the collected frames, or reject on timeout/close. */
  public async waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (predicate()) return;
      if (this.ended) {
        if (predicate()) return;
        throw new Error('stream ended before predicate was satisfied');
      }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) throw new Error('timed out waiting for SSE frames');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(remaining, 200));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  public async waitForEnd(timeoutMs = 4_000): Promise<void> {
    await this.waitFor(() => this.ended, timeoutMs).catch(() => {});
  }

  public eventIds(): string[] {
    return this.events.filter((f) => f.event && f.event !== 'stream.resync').map((f) => f.id ?? '');
  }

  public close(): void {
    try {
      this.res?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.req?.destroy();
    } catch {
      /* ignore */
    }
    this.finish();
  }
}

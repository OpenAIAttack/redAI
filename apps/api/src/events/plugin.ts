/**
 * Fastify SSE plugin for the workspace event stream (T11).
 *
 * `registerEvents(app, deps)` mounts `GET /api/v1/events` (owner-authenticated via the
 * injected guard, workspace-scoped, optional `project_id`/`run_id` filter). The
 * response is `text/event-stream`; each journal frame sets `id:` to the commit-ordered
 * `event_id` so a browser `EventSource` auto-replays via `Last-Event-ID` on reconnect.
 *
 * Delivery contract:
 *   - Commit-ordered: events are read strictly ascending and the cursor never advances
 *     past a gap a not-yet-committed lower id will fill (see EventStream.readAfter).
 *   - Cursor precedence (docs/06 §7): a valid `Last-Event-ID` header wins; else the
 *     `after` query; else 0 (from the beginning).
 *   - Reconnect: resuming with `Last-Event-ID` replays only after that id, so no loss;
 *     the client dedups by `event_id` for the normal overlap.
 *   - Expired cursor: an event after the cursor was purged by retention → a
 *     `stream.resync{cursor_expired}` frame (resync from snapshot), never a silent skip.
 *   - Future cursor / bad filter: rejected 400 before the stream opens.
 *   - Wakeups: Postgres NOTIFY, with a periodic poll fallback so a lost notify never
 *     loses an event.
 *   - Backpressure: a stalled consumer past the buffer bound is dropped with a resync
 *     signal instead of growing memory (see SseSession).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EventStream, type EventFilter } from '@redai/application/events';
import { cursorEnvelope } from '@redai/application/events';
import type { NotifySource } from './notify.js';
import { SseSession } from './sse.js';
import { sendError } from './errors.js';

export interface EventsOwnerContext {
  workspaceId: string;
  ownerId: string;
}

export interface EventsPluginOptions {
  /** Heartbeat comment interval (ms). docs/06 §7 suggests 15s. */
  heartbeatMs: number;
  /** Poll-fallback interval (ms) so a missed NOTIFY never loses an event. */
  pollMs: number;
  /** Bounded outbound buffer before a slow consumer is dropped (bytes). docs/06 §7: 1 MiB. */
  maxBufferBytes: number;
  /** Max journal rows fetched per read cycle. */
  batchLimit: number;
}

export interface EventsPluginDeps {
  stream: EventStream;
  notifications: NotifySource;
  authenticate: (req: FastifyRequest) => Promise<EventsOwnerContext | null>;
  options?: Partial<EventsPluginOptions>;
}

const DEFAULTS: EventsPluginOptions = {
  heartbeatMs: 15_000,
  pollMs: 1_000,
  maxBufferBytes: 1_048_576,
  batchLimit: 256,
};

const COUNTER_RE = /^(0|[1-9][0-9]{0,18})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function counterOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string' || !COUNTER_RE.test(value)) return null;
  return BigInt(value);
}

/** A resettable wake primitive: `wait()` resolves on the next `signal()`. */
function createWaker(): { wait: () => Promise<void>; signal: () => void } {
  let resolve: () => void = () => {};
  let promise = new Promise<void>((r) => (resolve = r));
  return {
    wait: () => promise,
    signal: () => {
      const r = resolve;
      promise = new Promise<void>((next) => (resolve = next));
      r();
    },
  };
}

export function registerEvents(app: FastifyInstance, deps: EventsPluginDeps): void {
  const opts: EventsPluginOptions = { ...DEFAULTS, ...(deps.options ?? {}) };
  const { stream, notifications } = deps;

  // Release the listen connection on shutdown. Registered here (after the pool's own
  // onClose in server.ts); avvio runs onClose LIFO, so this releases the client before
  // the pool ends.
  app.addHook('onClose', async () => {
    await notifications.close();
  });

  app.get('/api/v1/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
    }
    const workspaceId = ctx.workspaceId;

    // --- cursor: Last-Event-ID header wins if valid, else the `after` query, else 0.
    const query = (req.query ?? {}) as Record<string, unknown>;
    const headerRaw = req.headers['last-event-id'];
    const headerCursor = counterOrNull(Array.isArray(headerRaw) ? headerRaw[0] : headerRaw);
    let cursor: bigint;
    if (headerCursor !== null) {
      cursor = headerCursor;
    } else if (query['after'] !== undefined) {
      const afterCursor = counterOrNull(query['after']);
      if (afterCursor === null) {
        return sendError(reply, 400, 'EVENT_CURSOR_INVALID', 'The `after` cursor is malformed.');
      }
      cursor = afterCursor;
    } else {
      cursor = 0n;
    }

    // --- optional project/run filter (UUIDs, workspace-scoped).
    const filter: EventFilter = {};
    if (query['project_id'] !== undefined) {
      const projectId = query['project_id'];
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
        return sendError(reply, 400, 'INVALID_FILTER', 'project_id must be a UUID.');
      }
      filter.projectId = projectId;
    }
    if (query['run_id'] !== undefined) {
      const runId = query['run_id'];
      if (typeof runId !== 'string' || !UUID_RE.test(runId)) {
        return sendError(reply, 400, 'INVALID_FILTER', 'run_id must be a UUID.');
      }
      filter.runId = runId;
    }

    // --- classify BEFORE switching to event-stream so future/bad cursors get a 400.
    const cls = await stream.classifyCursor(workspaceId, cursor);
    if (cls === 'future') {
      return sendError(
        reply,
        400,
        'EVENT_CURSOR_INVALID',
        'The cursor is ahead of the workspace journal.',
      );
    }

    // --- switch the response to SSE and take over the socket.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();

    const session = new SseSession(reply.raw, { maxBufferBytes: opts.maxBufferBytes });
    session.retryHint(3_000);
    session.open();

    // Expired cursor: retention purged an event after the cursor. Signal resync from a
    // snapshot rather than silently skipping the gap, then end the stream so the client
    // acts (fetch snapshot, reconnect with the fresh snapshot_cursor).
    if (cls === 'expired') {
      session.sendResync('cursor_expired');
      session.end();
      return reply;
    }

    const waker = createWaker();
    const unsubscribe = notifications.subscribe(workspaceId, waker.signal);
    let alive = true;
    const stop = (): void => {
      alive = false;
      waker.signal();
    };
    reply.raw.on('close', stop);
    reply.raw.on('error', stop);

    const heartbeat = setInterval(() => {
      if (!session.heartbeat()) stop();
    }, opts.heartbeatMs);
    // Do not keep the process alive purely for a heartbeat timer.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.off('close', stop);
      reply.raw.off('error', stop);
      session.end();
    };

    // Drain every currently-available contiguous, filtered event. Returns false when
    // the socket died (so the outer loop exits).
    const drain = async (): Promise<boolean> => {
      for (;;) {
        if (!alive || session.closed) return false;
        const before = cursor;
        const result = await stream.readAfter(workspaceId, before, filter, opts.batchLimit);
        if (result.cursor === before) return true; // no progress (tail or in-flight gap)

        let lastEmitted = before;
        for (const event of result.events) {
          if (!session.sendEvent(event.event_id, event.type, JSON.stringify(event))) {
            return false;
          }
          lastEmitted = BigInt(event.event_id);
        }
        // The cursor moved past events the filter dropped: advance the client's
        // Last-Event-ID with a stream.cursor frame so a reconnect does not rescan them.
        if (result.cursor > lastEmitted) {
          const marker = cursorEnvelope(workspaceId, result.cursor);
          if (!session.sendEvent(marker.event_id, marker.type, JSON.stringify(marker))) {
            return false;
          }
        }
        cursor = result.cursor;
      }
    };

    void (async () => {
      try {
        while (alive && !session.closed) {
          if (!(await drain())) break;
          // Wait for a NOTIFY wake OR the poll timeout (fallback for a lost notify).
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, opts.pollMs);
            if (typeof timer.unref === 'function') timer.unref();
          });
          await Promise.race([waker.wait(), timeout]);
          if (timer) clearTimeout(timer);
        }
      } catch {
        // A read/write failure ends the stream; the client reconnects and replays.
      } finally {
        cleanup();
      }
    })();

    return reply;
  });
}

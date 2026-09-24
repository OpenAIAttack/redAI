/**
 * T11 — SSE commit-ordered event stream & reconnect (live PG16).
 *
 * Skips LOUDLY without DATABASE_URL (see ../db/support.ts). Each case gets its own
 * throwaway database, appends events through the real `redai_append_event`, and drives
 * the real Fastify SSE plugin over a real socket via a small `http` SSE client.
 *
 * Covers the required guarantees:
 *   - Commit inversion / no skip: a lower id whose txn commits LATER is never skipped,
 *     because the `event_counters` row lock serialises allocation to commit order.
 *   - Reconnect with Last-Event-ID resumes with no loss and no duplicate.
 *   - Expired (purged) cursor → stream.resync{cursor_expired}, not a silent skip.
 *   - NOTIFY-miss → the poll fallback still delivers the event.
 *   - Backpressure → a stalled consumer is dropped (connection closed), not OOM.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase, insertBaseGraph, type TestDatabase } from '../db/support.js';
import { appendEvent, withTransaction, type Pool } from '../../../packages/db/src/index.js';
import {
  createDbEventStream,
  createPgNotifySource,
  registerEvents,
  type NotifySource,
} from '../../../apps/api/src/events/index.js';
import { SseClient } from './sseClient.js';

const d = HAS_DB ? describe : describe.skip;

// `fastify` is a dependency of apps/api, not of the repo root, so resolve it from the
// apps/api package (the SSE plugin runs there in production).
const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const Fastify = apiRequire(
  'fastify',
) as typeof import('../../../apps/api/node_modules/fastify/fastify.js').default;
type FastifyInstance = ReturnType<typeof Fastify>;

const NO_NOTIFY: (pool: Pool) => NotifySource = () => ({
  subscribe: () => () => {},
  close: async () => {},
});

interface Ctx {
  db: TestDatabase;
  notify: NotifySource;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  base: string;
  app: FastifyInstance;
}

async function append(
  pool: Pool,
  workspaceId: string,
  input: { type: string; data: unknown; projectId?: string | null; runId?: string | null },
): Promise<bigint> {
  return withTransaction(pool, (tx) =>
    appendEvent(tx, {
      workspaceId,
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      eventType: input.type,
      payload: input.data,
    }),
  );
}

function stateChanged(reason: string | null = null): { type: string; data: unknown } {
  return {
    type: 'run.state_changed',
    data: { from: 'queued', to: 'running', reason_code: reason },
  };
}

async function boot(
  makeNotify: (pool: Pool) => NotifySource = NO_NOTIFY,
  options: { pollMs?: number; maxBufferBytes?: number } = {},
): Promise<Ctx> {
  const db = await createTestDatabase();
  const fx = await insertBaseGraph(db.pool);
  const notify = makeNotify(db.pool);

  const app = Fastify({ logger: false });
  registerEvents(app, {
    stream: createDbEventStream(db.pool),
    notifications: notify,
    authenticate: async () => ({ workspaceId: fx.workspaceId, ownerId: fx.ownerId }),
    options: {
      pollMs: options.pollMs ?? 250,
      heartbeatMs: 1_000,
      maxBufferBytes: options.maxBufferBytes ?? 1_048_576,
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    db,
    notify,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    ownerId: fx.ownerId,
    base: `http://127.0.0.1:${port}`,
    app,
  };
}

d('SSE event stream (T11)', () => {
  let ctx: Ctx | null = null;

  afterEach(async () => {
    if (!ctx) return;
    await ctx.app.close(); // runs the plugin onClose → notify.close() releases the LISTEN client
    await ctx.db.drop();
    ctx = null;
  });

  it('delivers committed events in commit order via the real LISTEN/NOTIFY path', async () => {
    ctx = await boot(createPgNotifySource);
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('a'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('b'));

    const client = new SseClient(ctx.base, '/api/v1/events');
    await client.connect();
    await client.waitFor(() => client.eventIds().length >= 2);
    expect(client.statusCode).toBe(200);
    expect(client.eventIds()).toEqual(['1', '2']);
    const first = client.events.find((f) => f.id === '1');
    expect(first?.event).toBe('run.state_changed');
    expect(JSON.parse(first!.data!).event_id).toBe('1');
    client.close();
  });

  it('commit inversion: a lower id committing later is never skipped', async () => {
    ctx = await boot();
    const { workspaceId } = ctx;
    const pool = ctx.db.pool;
    const stream = createDbEventStream(pool);

    // A allocates the first event_id under the counter lock but does not commit.
    const cA = await pool.connect();
    await cA.query('BEGIN');
    const aId = await cA.query<{ id: string }>(
      `SELECT redai_append_event($1,$2,$3,$4,$5::jsonb) AS id`,
      [workspaceId, null, null, 'run.state_changed', JSON.stringify(stateChanged('A').data)],
    );
    expect(aId.rows[0]!.id).toBe('1');

    // B allocates concurrently — it MUST block on the counter row lock, so it cannot
    // obtain a higher id (or commit) ahead of A.
    const cB = await pool.connect();
    await cB.query('BEGIN');
    let bDone = false;
    const bPromise = cB
      .query<{ id: string }>(`SELECT redai_append_event($1,$2,$3,$4,$5::jsonb) AS id`, [
        workspaceId,
        null,
        null,
        'run.state_changed',
        JSON.stringify(stateChanged('B').data),
      ])
      .then((r) => {
        bDone = true;
        return r;
      });

    // While A holds the lock: B is blocked and the reader sees NOTHING (id 1 uncommitted).
    await new Promise((r) => setTimeout(r, 300));
    expect(bDone).toBe(false);
    const beforeCommit = await stream.readAfter(workspaceId, 0n);
    expect(beforeCommit.events).toEqual([]);
    expect(beforeCommit.cursor).toBe(0n);

    // Commit A → id 1 visible; B unblocks, gets id 2, commits.
    await cA.query('COMMIT');
    const bRow = await bPromise;
    expect(bRow.rows[0]!.id).toBe('2');
    await cB.query('COMMIT');
    cA.release();
    cB.release();

    const afterCommit = await stream.readAfter(workspaceId, 0n);
    expect(afterCommit.events.map((e) => e.event_id)).toEqual(['1', '2']); // 1 before 2, no skip
  });

  it('reconnect with Last-Event-ID resumes with no loss and no duplicate', async () => {
    ctx = await boot();
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('e1'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('e2'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('e3'));

    const c1 = new SseClient(ctx.base, '/api/v1/events');
    await c1.connect();
    await c1.waitFor(() => c1.eventIds().length >= 3);
    expect(c1.eventIds()).toEqual(['1', '2', '3']);
    c1.close();

    await append(ctx.db.pool, ctx.workspaceId, stateChanged('e4'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('e5'));

    const c2 = new SseClient(ctx.base, '/api/v1/events', { lastEventId: '3' });
    await c2.connect();
    await c2.waitFor(() => c2.eventIds().length >= 2);
    expect(c2.eventIds()).toEqual(['4', '5']); // no loss, no re-delivery of 1..3
    c2.close();
  });

  it('a mid-stream cursor replays exactly the tail (unique ascending ids allow dedup)', async () => {
    ctx = await boot();
    for (let i = 0; i < 4; i += 1)
      await append(ctx.db.pool, ctx.workspaceId, stateChanged(`n${i}`));

    const client = new SseClient(ctx.base, '/api/v1/events', { lastEventId: '2' });
    await client.connect();
    await client.waitFor(() => client.eventIds().length >= 2);
    expect(client.eventIds()).toEqual(['3', '4']);
    const ids = client.eventIds();
    expect(new Set(ids).size).toBe(ids.length); // unique
    client.close();
  });

  it('expired/too-old cursor yields a resync signal, not a silent skip', async () => {
    ctx = await boot();
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('p1'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('p2'));
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('p3'));
    // Retention purges the oldest rows; the counter stays put (earliest surviving id = 3).
    await ctx.db.pool.query('DELETE FROM events WHERE workspace_id = $1 AND event_id <= 2', [
      ctx.workspaceId,
    ]);

    const client = new SseClient(ctx.base, '/api/v1/events', { lastEventId: '0' });
    await client.connect();
    await client.waitFor(() => client.events.some((f) => f.event === 'stream.resync'));
    const resync = client.events.find((f) => f.event === 'stream.resync');
    expect(resync?.data).toContain('cursor_expired');
    // No journal event frames before the resync — the purged span is not silently skipped.
    expect(client.eventIds().filter((id) => id !== '')).toEqual([]);
    client.close();
  });

  it('future cursor is rejected 400 before the stream opens', async () => {
    ctx = await boot();
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('one'));
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { 'last-event-id': '999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EVENT_CURSOR_INVALID');
  });

  it('project filter advances the cursor with a stream.cursor frame over skipped events', async () => {
    ctx = await boot();
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('root')); // id1, no project
    await append(ctx.db.pool, ctx.workspaceId, {
      ...stateChanged('scoped'),
      projectId: ctx.projectId,
    }); // id2
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('root2')); // id3, no project

    const client = new SseClient(ctx.base, `/api/v1/events?project_id=${ctx.projectId}`);
    await client.connect();
    await client.waitFor(() => client.events.some((f) => f.event === 'stream.cursor'));
    const matched = client.events.filter((f) => f.event === 'run.state_changed');
    expect(matched.map((f) => f.id)).toEqual(['2']); // only the scoped event leaks
    const cursorFrame = client.events.find((f) => f.event === 'stream.cursor');
    expect(cursorFrame?.id).toBe('3'); // Last-Event-ID advances past the skipped id3
    expect(JSON.parse(cursorFrame!.data!).data.cursor).toBe('3');
    client.close();
  });

  it('NOTIFY-miss: the poll fallback still delivers an event with no notify', async () => {
    // NO_NOTIFY never wakes anyone — the only delivery path is the poll timer.
    ctx = await boot(NO_NOTIFY, { pollMs: 150 });

    const client = new SseClient(ctx.base, '/api/v1/events');
    await client.connect();
    await new Promise((r) => setTimeout(r, 100));
    expect(client.eventIds()).toEqual([]);
    await append(ctx.db.pool, ctx.workspaceId, stateChanged('polled'));
    await client.waitFor(() => client.eventIds().length >= 1, 3_000);
    expect(client.eventIds()).toEqual(['1']);
    client.close();
  });

  it('backpressure: a stalled consumer past the bound is dropped, not buffered forever', async () => {
    ctx = await boot(NO_NOTIFY, { pollMs: 100, maxBufferBytes: 128 * 1024 });
    const bigText = 'x'.repeat(16_000);
    for (let i = 0; i < 200; i += 1) {
      await append(ctx.db.pool, ctx.workspaceId, {
        type: 'message.delta',
        data: {
          message_id: ctx.workspaceId,
          generation_id: ctx.workspaceId,
          delta_seq: String(i),
          text: bigText,
          provisional: true,
        },
      });
    }

    // A client that never reads: ~3.2 MiB pending, far past the 128 KiB bound + kernel
    // buffers. The server must close the connection rather than grow memory unbounded.
    const client = new SseClient(ctx.base, '/api/v1/events', { pause: true });
    await client.connect();
    await client.waitForEnd(6_000);
    expect(client.ended).toBe(true);
    expect(client.eventIds().length).toBeLessThan(200);
    client.close();
  });
});

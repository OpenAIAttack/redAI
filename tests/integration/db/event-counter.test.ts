import { describe, expect, it } from 'vitest';
import { appendEvent, withTransaction } from '../../../packages/db/src/index.js';
import { HAS_DB, createTestDatabase, insertBaseGraph } from './support.js';

const d = HAS_DB ? describe : describe.skip;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

d('event counter: commit-ordered, gap-free per workspace (INV-009)', () => {
  it('serializes two concurrent transactions so counter order == commit order', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const ws = base.workspaceId;

      // Pre-seed one committed event so the counter row exists (event_id 1).
      await withTransaction(db.pool, (tx) =>
        appendEvent(tx, { workspaceId: ws, projectId: base.projectId, eventType: 'seed', payload: {} }),
      );

      const clientA = await db.pool.connect();
      const clientB = await db.pool.connect();
      try {
        await clientA.query('BEGIN');
        const aId = await clientA
          .query<{ event_id: string }>(
            'SELECT redai_append_event($1, $2, NULL, $3, $4::jsonb) AS event_id',
            [ws, base.projectId, 'A', JSON.stringify({ who: 'A' })],
          )
          .then((r) => BigInt(r.rows[0]!.event_id));
        expect(aId).toBe(2n); // A allocated first while holding the counter lock

        // B starts its append while A still holds the row lock — it MUST block.
        await clientB.query('BEGIN');
        const bPromise = clientB.query<{ event_id: string }>(
          'SELECT redai_append_event($1, $2, NULL, $3, $4::jsonb) AS event_id',
          [ws, base.projectId, 'B', JSON.stringify({ who: 'B' })],
        );
        const state = await Promise.race([
          bPromise.then(() => 'resolved' as const),
          delay(300).then(() => 'blocked' as const),
        ]);
        expect(state).toBe('blocked');

        // A commits first → releases the lock; B now proceeds and gets the next id.
        await clientA.query('COMMIT');
        const bId = BigInt((await bPromise).rows[0]!.event_id);
        await clientB.query('COMMIT');
        expect(bId).toBe(3n);
      } finally {
        clientA.release();
        clientB.release();
      }

      // Journal is contiguous 1,2,3 with commit order A(2) before B(3).
      const rows = await db.pool.query<{ event_id: string; event_type: string }>(
        'SELECT event_id, event_type FROM events WHERE workspace_id = $1 ORDER BY event_id',
        [ws],
      );
      expect(rows.rows.map((r) => Number(r.event_id))).toEqual([1, 2, 3]);
      expect(rows.rows.map((r) => r.event_type)).toEqual(['seed', 'A', 'B']);
    } finally {
      await db.drop();
    }
  });

  it('produces a gap-free, unique sequence under many concurrent commits', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const ws = base.workspaceId;
      const N = 30;

      const ids = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          withTransaction(db.pool, (tx) =>
            appendEvent(tx, {
              workspaceId: ws,
              projectId: base.projectId,
              eventType: `e${i}`,
              payload: { i },
            }),
          ),
        ),
      );

      const sorted = ids.map(Number).sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // exactly 1..N, no gaps/dupes

      const counter = await db.pool.query<{ next_event_id: string }>(
        'SELECT next_event_id FROM event_counters WHERE workspace_id = $1',
        [ws],
      );
      expect(Number(counter.rows[0]!.next_event_id)).toBe(N + 1);

      const persisted = await db.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM events WHERE workspace_id = $1',
        [ws],
      );
      expect(Number(persisted.rows[0]!.n)).toBe(N);
    } finally {
      await db.drop();
    }
  });
});

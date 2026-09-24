import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HAS_DB, createTestDatabase, insertBaseGraph, future } from './support.js';

const d = HAS_DB ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const specLock = JSON.parse(
  readFileSync(resolve(here, '../../../SPEC_LOCK.json'), 'utf8'),
) as { defaults: { max_active_runs_chat: number; max_active_runs_workspace: number } };

async function insertRun(
  pool: import('../../../packages/db/src/index.js').Pool,
  base: { workspaceId: string; projectId: string; providerConfigId: string },
  chatId: string,
  state = 'running',
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO runs (workspace_id, project_id, chat_id, mode, state, provider_config_id,
                       config_snapshot, budget_limit_micro_usd, expires_at)
     VALUES ($1, $2, $3, 'agent', $4, $5, '{}'::jsonb, 0, $6) RETURNING id`,
    [base.workspaceId, base.projectId, chatId, state, base.providerConfigId, future()],
  );
  return r.rows[0]!.id;
}

d('active-run uniqueness (INV-002)', () => {
  it('enforces max_active_runs_chat = 1 via the partial unique index', async () => {
    expect(specLock.defaults.max_active_runs_chat).toBe(1);
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      await insertRun(db.pool, base, base.chatId, 'running');

      // Second ACTIVE run on the same chat → unique violation (one_active_run_per_chat).
      await expect(insertRun(db.pool, base, base.chatId, 'queued')).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      await db.drop();
    }
  });

  it('allows a new active run once the previous run reaches a terminal state', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const first = await insertRun(db.pool, base, base.chatId, 'running');

      // Terminal states are outside the partial index predicate.
      await db.pool.query(`UPDATE runs SET state = 'completed' WHERE id = $1`, [first]);

      // A fresh active run is now permitted on the same chat.
      const second = await insertRun(db.pool, base, base.chatId, 'queued');
      expect(second).not.toBe(first);
    } finally {
      await db.drop();
    }
  });

  it('does NOT cap active runs per workspace in the DB (application-level invariant)', async () => {
    // max_active_runs_workspace is enforced in the create-run transaction, not the schema.
    // This test documents that the DB alone permits more, so the app MUST check it.
    expect(specLock.defaults.max_active_runs_workspace).toBe(2);
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const chat2 = await db.pool.query<{ id: string }>(
        `INSERT INTO chats (workspace_id, project_id, title) VALUES ($1, $2, 'C2') RETURNING id`,
        [base.workspaceId, base.projectId],
      );
      const chat3 = await db.pool.query<{ id: string }>(
        `INSERT INTO chats (workspace_id, project_id, title) VALUES ($1, $2, 'C3') RETURNING id`,
        [base.workspaceId, base.projectId],
      );
      await insertRun(db.pool, base, base.chatId, 'running');
      await insertRun(db.pool, base, chat2.rows[0]!.id, 'running');
      // 3rd active run across a different chat: DB accepts it (workspace cap is app-level).
      const third = await insertRun(db.pool, base, chat3.rows[0]!.id, 'running');
      expect(third).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await db.drop();
    }
  });
});

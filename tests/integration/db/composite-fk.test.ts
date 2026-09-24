import { describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase, insertBaseGraph, future } from './support.js';

const d = HAS_DB ? describe : describe.skip;

/**
 * INV-001 ownership closure. Composite FKs `(child, project_id, workspace_id)` make
 * a valid UUID from ANOTHER project insufficient: the row is rejected at the DB.
 */
d('composite FK: cross-project references are rejected', () => {
  it('a run cannot reference a chat that lives in a different project', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool); // chat lives in project A
      const projectB = await db.pool.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, name) VALUES ($1, 'B') RETURNING id`,
        [base.workspaceId],
      );
      const projectBId = projectB.rows[0]!.id;

      // NEGATIVE: chat_id is A's chat but project_id claims B → composite FK violation (23503).
      await expect(
        db.pool.query(
          `INSERT INTO runs (workspace_id, project_id, chat_id, mode, provider_config_id,
                             config_snapshot, budget_limit_micro_usd, expires_at)
           VALUES ($1, $2, $3, 'agent', $4, '{}'::jsonb, 0, $5)`,
          [base.workspaceId, projectBId, base.chatId, base.providerConfigId, future()],
        ),
      ).rejects.toMatchObject({ code: '23503' });

      // POSITIVE control: same chat with its true project_id (A) inserts fine.
      const ok = await db.pool.query<{ id: string }>(
        `INSERT INTO runs (workspace_id, project_id, chat_id, mode, provider_config_id,
                           config_snapshot, budget_limit_micro_usd, expires_at)
         VALUES ($1, $2, $3, 'agent', $4, '{}'::jsonb, 0, $5) RETURNING id`,
        [base.workspaceId, base.projectId, base.chatId, base.providerConfigId, future()],
      );
      expect(ok.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await db.drop();
    }
  });

  it('a message cannot attach to a run from a different project', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const run = await db.pool.query<{ id: string }>(
        `INSERT INTO runs (workspace_id, project_id, chat_id, mode, provider_config_id,
                           config_snapshot, budget_limit_micro_usd, expires_at)
         VALUES ($1, $2, $3, 'agent', $4, '{}'::jsonb, 0, $5) RETURNING id`,
        [base.workspaceId, base.projectId, base.chatId, base.providerConfigId, future()],
      );
      const runId = run.rows[0]!.id;

      const projectB = await db.pool.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, name) VALUES ($1, 'B') RETURNING id`,
        [base.workspaceId],
      );
      const projectBId = projectB.rows[0]!.id;
      const chatB = await db.pool.query<{ id: string }>(
        `INSERT INTO chats (workspace_id, project_id, title) VALUES ($1, $2, 'CB') RETURNING id`,
        [base.workspaceId, projectBId],
      );
      const chatBId = chatB.rows[0]!.id;

      // NEGATIVE: message in project B's chat but pointing at project A's run.
      await expect(
        db.pool.query(
          `INSERT INTO messages (workspace_id, project_id, chat_id, run_id, seq, role)
           VALUES ($1, $2, $3, $4, 1, 'assistant')`,
          [base.workspaceId, projectBId, chatBId, runId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await db.drop();
    }
  });
});

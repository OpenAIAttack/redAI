import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../packages/db/src/index.js';
import { HAS_DB, createTestDatabase, insertBaseGraph } from './support.js';

const d = HAS_DB ? describe : describe.skip;

const HEX64 = 'a'.repeat(64);

d('immutable rows (INV-003 versions, INV-007 artifacts)', () => {
  it('rejects UPDATE of a scope_version (immutable authority)', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const sv = await db.pool.query<{ id: string }>(
        `INSERT INTO scope_versions (workspace_id, project_id, version, policy, policy_sha256, created_by)
         VALUES ($1, $2, 1, '{}'::jsonb, $3, $4) RETURNING id`,
        [base.workspaceId, base.projectId, HEX64, base.ownerId],
      );
      await expect(
        db.pool.query(`UPDATE scope_versions SET version = 2 WHERE id = $1`, [sv.rows[0]!.id]),
      ).rejects.toMatchObject({ code: '23514' });

      // DELETE is intentionally permitted (controlled purge, not overwrite — INV-007/§6).
      const del = await db.pool.query(`DELETE FROM scope_versions WHERE id = $1`, [sv.rows[0]!.id]);
      expect(del.rowCount).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('rejects UPDATE of a finding_version (verification history is immutable)', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const fvId = await withTransaction(db.pool, async (tx) => {
        // findings.current_version references finding_versions(finding_id, version) DEFERRED.
        const f = await tx.query<{ id: string }>(
          `INSERT INTO findings (workspace_id, project_id, dedup_fingerprint)
           VALUES ($1, $2, 'fp') RETURNING id`,
          [base.workspaceId, base.projectId],
        );
        const findingId = f.rows[0]!.id;
        const fv = await tx.query<{ id: string }>(
          `INSERT INTO finding_versions
             (workspace_id, project_id, finding_id, version, title, content, severity, created_by)
           VALUES ($1, $2, $3, 1, 'T', '{}'::jsonb, 'low', $4) RETURNING id`,
          [base.workspaceId, base.projectId, findingId, base.ownerId],
        );
        return fv.rows[0]!.id;
      });

      await expect(
        db.pool.query(`UPDATE finding_versions SET title = 'changed' WHERE id = $1`, [fvId]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.drop();
    }
  });

  it('rejects payload overwrite of a finalized artifact but allows non-payload updates', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const art = await db.pool.query<{ id: string }>(
        `INSERT INTO artifacts (workspace_id, project_id, filename, media_type, kind,
                                byte_size, sha256, storage_key, status)
         VALUES ($1, $2, 'f.txt', 'text/plain', 'evidence', 10, $3, $4, 'ready') RETURNING id`,
        [base.workspaceId, base.projectId, HEX64, `key/${base.projectId}`],
      );
      const artId = art.rows[0]!.id;

      // NEGATIVE: mutating a payload column on a finalized (ready) artifact.
      await expect(
        db.pool.query(`UPDATE artifacts SET sha256 = $2 WHERE id = $1`, [artId, 'b'.repeat(64)]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.pool.query(`UPDATE artifacts SET byte_size = 99 WHERE id = $1`, [artId]),
      ).rejects.toMatchObject({ code: '23514' });

      // POSITIVE: a non-payload update (classification) is allowed on a finalized artifact.
      const ok = await db.pool.query(
        `UPDATE artifacts SET classification = 'sensitive' WHERE id = $1`,
        [artId],
      );
      expect(ok.rowCount).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('allows payload changes while an artifact is still pending (not yet finalized)', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const art = await db.pool.query<{ id: string }>(
        `INSERT INTO artifacts (workspace_id, project_id, filename, media_type, kind,
                                byte_size, sha256, storage_key, status)
         VALUES ($1, $2, 'f.txt', 'text/plain', 'evidence', 0, $3, $4, 'pending') RETURNING id`,
        [base.workspaceId, base.projectId, HEX64, `key2/${base.projectId}`],
      );
      const artId = art.rows[0]!.id;
      // Finalize: set real size/digest and flip to ready in one update — allowed (was pending).
      const ok = await db.pool.query(
        `UPDATE artifacts SET byte_size = 10, sha256 = $2, status = 'ready', ready_at = now()
         WHERE id = $1`,
        [artId, 'c'.repeat(64)],
      );
      expect(ok.rowCount).toBe(1);
    } finally {
      await db.drop();
    }
  });
});

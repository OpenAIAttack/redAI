import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrate,
  loadMigrations,
  defaultMigrationsDir,
} from '../../../packages/db/src/index.js';
import { HAS_DB, createTestDatabase } from './support.js';

const d = HAS_DB ? describe : describe.skip;

d('migrations: fresh apply + ordered upgrade smoke', () => {
  const migrationsDir = defaultMigrationsDir();

  it('reference dir has ordered, well-formed migrations', () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations.map((m) => m.version)).toEqual(['0001', '0002']);
    for (const m of migrations) expect(m.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('applies 0001 then 0002 in order on an empty DB, tracking each', async () => {
    const db = await createTestDatabase({ migrateDb: false });
    try {
      // Phase 1: apply ONLY 0001 from an isolated dir (simulates an earlier release).
      const stageDir = mkdtempSync(join(tmpdir(), 'redai-mig-'));
      copyFileSync(join(migrationsDir, '0001_init_schema.sql'), join(stageDir, '0001_init_schema.sql'));
      const first = await migrate(db.pool, { dir: stageDir });
      expect(first.applied.map((m) => m.version)).toEqual(['0001']);

      // After 0001: core tables exist, but the 0002 event helper does NOT yet.
      const tables = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='runs'`,
      );
      expect(tables.rows[0]!.n).toBe('1');
      const fnBefore = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_proc WHERE proname='redai_append_event'`,
      );
      expect(fnBefore.rows[0]!.n).toBe('0');

      // Phase 2: upgrade with the full dir — 0002 applied, 0001 skipped by checksum.
      const second = await migrate(db.pool, { dir: migrationsDir });
      expect(second.applied.map((m) => m.version)).toEqual(['0002']);
      expect(second.skipped.map((m) => m.version)).toEqual(['0001']);

      const fnAfter = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_proc WHERE proname='redai_append_event'`,
      );
      expect(fnAfter.rows[0]!.n).toBe('1');

      // Tracking table records both, in order.
      const recorded = await db.pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(recorded.rows.map((r) => r.version)).toEqual(['0001', '0002']);

      // Phase 3: re-run is a no-op (no ORM auto-sync).
      const third = await migrate(db.pool, { dir: migrationsDir });
      expect(third.applied).toEqual([]);
      expect(third.skipped.map((m) => m.version)).toEqual(['0001', '0002']);
    } finally {
      await db.drop();
    }
  });

  it('rejects a recorded migration whose on-disk checksum changed (drift guard)', async () => {
    const db = await createTestDatabase({ migrateDb: false });
    try {
      const stageDir = mkdtempSync(join(tmpdir(), 'redai-drift-'));
      const original = readFileSync(join(migrationsDir, '0001_init_schema.sql'), 'utf8');
      writeFileSync(join(stageDir, '0001_init_schema.sql'), original);
      await migrate(db.pool, { dir: stageDir });

      // Tamper: same version, different bytes.
      writeFileSync(
        join(stageDir, '0001_init_schema.sql'),
        original + '\n-- tampered after apply\n',
      );
      await expect(migrate(db.pool, { dir: stageDir })).rejects.toThrow(/drift/i);
    } finally {
      await db.drop();
    }
  });
});

/**
 * Explicit, forward-only migration runner. No ORM auto-sync/drop: schema change
 * happens only by applying versioned files in `db/migrations`, tracked in
 * `schema_migrations`. Each file is applied as one multi-statement query inside a
 * single transaction, so a partial file cannot leave a half-applied schema.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Pool } from 'pg';

export interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  filename: string;
  checksum: string;
  alreadyApplied: boolean;
}

export interface MigrateResult {
  applied: AppliedMigration[];
  skipped: AppliedMigration[];
}

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Absolute path to the repo's `db/migrations` directory, resolved from this module. */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/db/src -> packages/db -> packages -> repo root -> db/migrations
  return resolve(here, '..', '..', '..', 'db', 'migrations');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Load `*.sql` migrations from a directory, sorted by version. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort((a, b) => a.localeCompare(b));
  return files.map((filename) => {
    const match = MIGRATION_FILE.exec(filename);
    if (!match || match[1] === undefined) {
      throw new Error(`migration filename does not match NNNN_name.sql: ${filename}`);
    }
    const sql = readFileSync(join(dir, filename), 'utf8');
    return { version: match[1], filename, sql, checksum: sha256(sql) };
  });
}

async function ensureTrackingTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(pool: Pool): Promise<Map<string, { filename: string; checksum: string }>> {
  const result = await pool.query<{ version: string; filename: string; checksum: string }>(
    'SELECT version, filename, checksum FROM schema_migrations',
  );
  const map = new Map<string, { filename: string; checksum: string }>();
  for (const row of result.rows) {
    map.set(row.version, { filename: row.filename, checksum: row.checksum });
  }
  return map;
}

/**
 * Apply all pending migrations in order. Already-recorded migrations are skipped,
 * and a drift (recorded checksum != on-disk checksum) throws instead of re-applying.
 */
export async function migrate(
  pool: Pool,
  options: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const dir = options.dir ?? defaultMigrationsDir();
  const log = options.log ?? (() => {});
  const migrations = loadMigrations(dir);
  if (migrations.length === 0) {
    throw new Error(`no migrations found in ${dir}`);
  }

  await ensureTrackingTable(pool);
  const applied = await readApplied(pool);

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    const prior = applied.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        throw new Error(
          `migration drift for ${m.filename}: recorded checksum ${prior.checksum} != on-disk ${m.checksum}. ` +
            'Migrations are immutable once applied; author a new migration instead of editing an applied one.',
        );
      }
      result.skipped.push({ ...toApplied(m), alreadyApplied: true });
      log(`skip   ${m.filename} (already applied)`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
        [m.version, m.filename, m.checksum],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${m.filename} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
    result.applied.push({ ...toApplied(m), alreadyApplied: false });
    log(`apply  ${m.filename}`);
  }

  return result;
}

function toApplied(m: Migration): Omit<AppliedMigration, 'alreadyApplied'> {
  return { version: m.version, filename: m.filename, checksum: m.checksum };
}

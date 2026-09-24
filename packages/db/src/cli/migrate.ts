/**
 * CLI entry for `pnpm --filter @redai/db run migrate`.
 *
 * Reads `DATABASE_URL`, applies every pending migration from `db/migrations` in
 * order, prints a summary, and exits non-zero on failure. This is the *only*
 * supported way the schema changes — there is no auto-synchronize on app boot.
 */
import { createPool } from '../pool.js';
import { migrate } from '../migrate.js';

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Example:');
    console.error('  DATABASE_URL=postgres://redai@127.0.0.1:55432/postgres pnpm --filter @redai/db run migrate');
    process.exit(2);
  }

  const pool = createPool({ connectionString, applicationName: 'redai-migrate' });
  try {
    const result = await migrate(pool, { log: (msg) => console.log(msg) });
    console.log(
      `migrations complete: ${result.applied.length} applied, ${result.skipped.length} already present`,
    );
  } catch (err) {
    console.error(`migration failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();

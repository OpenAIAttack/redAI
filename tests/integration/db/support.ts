/**
 * Integration test support: each suite gets its OWN throwaway database on the
 * PostgreSQL 16 cluster named by DATABASE_URL, created and dropped by the test so
 * suites never share mutable state.
 *
 * If DATABASE_URL is unset the suites skip LOUDLY (see `describeDb`). In the T02
 * task environment the cluster is started for real and the suites run green.
 *
 * `@redai/db` is imported by relative path to its TypeScript source so that its
 * `pg` dependency resolves from `packages/db/node_modules` under vitest/esbuild,
 * with no change to shared workspace config.
 */
import { randomBytes } from 'node:crypto';
import { createPool, migrate } from '../../../packages/db/src/index.js';
import type { Pool } from '../../../packages/db/src/index.js';

export const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[T02] DATABASE_URL is not set — DB integration suites are SKIPPED.\n' +
      '      Start a throwaway PostgreSQL 16 cluster and export DATABASE_URL, e.g.:\n' +
      '        export PGBIN=/usr/lib/postgresql/16/bin\n' +
      '        export PGDATA=$PWD/.tmp-pg/t02 PGPORT=55432\n' +
      '        "$PGBIN/initdb" -D "$PGDATA" -U redai --auth=trust\n' +
      '        "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp" -l "$PGDATA/log" start\n' +
      '        export DATABASE_URL="postgres://redai@127.0.0.1:$PGPORT/postgres"\n' +
      '      then re-run: pnpm exec vitest run tests/integration/db\n',
  );
}

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export interface TestDatabase {
  name: string;
  url: string;
  pool: Pool;
  /** End the pool and drop the database. Always call in afterAll/afterEach. */
  drop: () => Promise<void>;
}

/**
 * Create a fresh database `redai_t02_<rand>`, run all migrations against it, and
 * return a pool bound to it. `migrateDb` defaults to true; pass false to inspect the
 * raw create (used by the migration suite that drives the runner itself).
 */
export async function createTestDatabase(
  options: { migrateDb?: boolean } = {},
): Promise<TestDatabase> {
  if (!HAS_DB || !DATABASE_URL) {
    throw new Error('createTestDatabase called without DATABASE_URL');
  }
  const name = `redai_t02_${randomBytes(6).toString('hex')}`;
  const admin = createPool({ connectionString: DATABASE_URL, max: 1, applicationName: 'redai-t02-admin' });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(DATABASE_URL, name);
  const pool = createPool({ connectionString: url, max: 8, applicationName: `redai-t02-${name}` });

  if (options.migrateDb !== false) {
    await migrate(pool);
  }

  const drop = async (): Promise<void> => {
    await pool.end().catch(() => {});
    const dropAdmin = createPool({ connectionString: DATABASE_URL, max: 1 });
    try {
      // FORCE terminates any lingering backends (PG13+).
      await dropAdmin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await dropAdmin.end();
    }
  };

  return { name, url, pool, drop };
}

/**
 * Insert a minimal graph (workspace, owner, project, chat, provider_config) that
 * later rows reference. Returns the created ids. Uses direct SQL so it works with any
 * executor and is independent of the repository layer under test.
 */
export interface Fixtures {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  chatId: string;
  providerConfigId: string;
}

export async function insertBaseGraph(pool: Pool): Promise<Fixtures> {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name, installation_id) VALUES ('redAI', gen_random_uuid()) RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;

  const owner = await pool.query<{ id: string }>(
    `INSERT INTO owners (workspace_id, username, password_hash, recovery_code_hash)
     VALUES ($1, 'owner', 'x', '\\x00') RETURNING id`,
    [workspaceId],
  );
  const ownerId = owner.rows[0]!.id;

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, name) VALUES ($1, 'P') RETURNING id`,
    [workspaceId],
  );
  const projectId = project.rows[0]!.id;

  const chat = await pool.query<{ id: string }>(
    `INSERT INTO chats (workspace_id, project_id, title) VALUES ($1, $2, 'C') RETURNING id`,
    [workspaceId, projectId],
  );
  const chatId = chat.rows[0]!.id;

  const provider = await pool.query<{ id: string }>(
    `INSERT INTO provider_configs (workspace_id, display_name, config)
     VALUES ($1, 'pc', '{}'::jsonb) RETURNING id`,
    [workspaceId],
  );
  const providerConfigId = provider.rows[0]!.id;

  return { workspaceId, ownerId, projectId, chatId, providerConfigId };
}

/** A far-future expiry for runs created in tests. */
export function future(hours = 24): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

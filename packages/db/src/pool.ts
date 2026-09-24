/**
 * Connection pool factory and the executor abstraction shared by repositories.
 *
 * `@redai/db` depends only on `@redai/domain` (kept pure) and `pg`. Nothing here
 * imports HTTP, UI, provider SDKs or the domain's forbidden modules.
 */
import pg from 'pg';
import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

const { Pool: PgPool, types } = pg;

// bigint (OID 20) arrives as a JS string by default; keep it that way. Ledger and
// counter columns are bigint and must not lose precision through Number. Callers
// parse with BigInt where they need arithmetic.
types.setTypeParser(20, (v) => v);

/**
 * Minimal surface both a `Pool` and a `PoolClient` satisfy. Repositories accept an
 * `Executor` so the same method works standalone (pool) or inside a transaction
 * (client), without a repository ever opening its own connection.
 */
export interface Executor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface CreatePoolOptions {
  connectionString: string;
  /** Hard cap on pool size; small by default for a single-owner install. */
  max?: number;
  /** ms before an idle client is closed. */
  idleTimeoutMillis?: number;
  /** ms to wait for a connection before failing. */
  connectionTimeoutMillis?: number;
  /** Optional application_name for pg_stat_activity visibility. */
  applicationName?: string;
  /**
   * Handler for asynchronous errors emitted by idle clients (e.g. the backend is
   * terminated out from under the pool). Defaults to a no-op. pg REQUIRES a
   * listener here: without one, an idle-client error is an unhandled `error`
   * event that crashes the process. A real observability sink is wired in T32.
   */
  onError?: (err: Error) => void;
}

/** Create a `pg.Pool`. The caller owns its lifecycle and must `await pool.end()`. */
export function createPool(options: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
  };
  const pool = new PgPool(config);
  // Always attach an error listener so a dropped idle backend (e.g. a test
  // dropping its database with FORCE) never becomes an unhandled process error.
  const onError = options.onError ?? (() => {});
  pool.on('error', onError);
  return pool;
}

/** Liveness probe used by the API health readiness check (D03). Returns true iff `SELECT 1` succeeds. */
export async function pingDatabase(executor: Executor): Promise<boolean> {
  try {
    const result = await executor.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export type { Pool, PoolClient, QueryResult, QueryResultRow };

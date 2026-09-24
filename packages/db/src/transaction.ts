/**
 * Transaction wrapper. Business mutations that must be durable-before-effect
 * (INV-004) and event-consistent (INV-009) run inside `withTransaction`, which
 * checks out one client, runs `BEGIN`, and commits or rolls back around the callback.
 */
import type { Pool, PoolClient } from 'pg';
import type { Executor } from './pool.js';

export type IsolationLevel =
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /** Open the transaction READ ONLY (rejects writes at the DB level). */
  readOnly?: boolean;
  /** Mark DEFERRABLE (only meaningful with serializable + read only). */
  deferrable?: boolean;
}

/**
 * The value handed to a transaction callback: a client that also carries the
 * `Executor` shape, so repository methods accept it directly.
 */
export type Tx = PoolClient & Executor;

function beginStatement(options: TransactionOptions): string {
  const parts = ['BEGIN'];
  if (options.isolationLevel) parts.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
  if (options.readOnly) parts.push('READ ONLY');
  if (options.deferrable) parts.push('DEFERRABLE');
  return parts.join(' ');
}

/**
 * Run `fn` inside a single transaction. Commits on resolve, rolls back on throw,
 * and always releases the client. The callback must use the supplied `tx` for all
 * of its statements — using the outer pool would run outside the transaction.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = (await pool.connect()) as Tx;
  try {
    await client.query(beginStatement(options));
    let result: T;
    try {
      result = await fn(client);
    } catch (err) {
      await safeRollback(client);
      throw err;
    }
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A failed ROLLBACK means the connection is unusable; release() will discard it.
  }
}

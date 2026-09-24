/**
 * Event-counter helper (INV-009). `redai_append_event` allocates a per-workspace,
 * commit-ordered cursor under a row lock held until COMMIT, then inserts the event
 * in the SAME transaction as the business mutation. Callers MUST pass a transaction
 * executor (`Tx`), never the bare pool: appending on the pool would commit the event
 * independently of the mutation and break durable-before-effect / event consistency.
 */
import type { Executor } from './pool.js';

export interface AppendEventInput {
  workspaceId: string;
  projectId?: string | null;
  runId?: string | null;
  eventType: string;
  payload: unknown;
}

/**
 * Append a durable event and return its allocated per-workspace `event_id`.
 * Run this inside `withTransaction` alongside the mutation it records.
 */
export async function appendEvent(tx: Executor, input: AppendEventInput): Promise<bigint> {
  const result = await tx.query<{ event_id: string }>(
    'SELECT redai_append_event($1, $2, $3, $4, $5::jsonb) AS event_id',
    [
      input.workspaceId,
      input.projectId ?? null,
      input.runId ?? null,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const raw = result.rows[0]?.event_id;
  if (raw === undefined) {
    throw new Error('redai_append_event returned no event_id');
  }
  return BigInt(raw);
}

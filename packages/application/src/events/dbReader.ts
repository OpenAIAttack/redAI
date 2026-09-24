/**
 * DB-backed {@link EventJournalReader} over `@redai/db` (T11).
 *
 * Reads are pull-based and strictly workspace-scoped: every statement carries an
 * explicit `workspace_id` predicate, so a subscriber authenticated for workspace A
 * can never read workspace B's journal. `event_id` is a bigint; `@redai/db` parses
 * bigint columns as strings to avoid precision loss, so we convert at the boundary.
 */
import type { Executor } from '@redai/db';
import type { EventJournalReader, EventRow } from './ports.js';

interface RawEventRow {
  workspace_id: string;
  event_id: string;
  project_id: string | null;
  run_id: string | null;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

function mapRaw(row: RawEventRow): EventRow {
  return {
    workspaceId: row.workspace_id,
    eventId: BigInt(row.event_id),
    projectId: row.project_id,
    runId: row.run_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export function createDbEventJournalReader(exec: Executor): EventJournalReader {
  return {
    async readAfter(workspaceId, afterCursor, limit) {
      const result = await exec.query<RawEventRow>(
        `SELECT workspace_id, event_id, project_id, run_id, event_type, payload, created_at
           FROM events
          WHERE workspace_id = $1 AND event_id > $2
          ORDER BY event_id ASC
          LIMIT $3`,
        [workspaceId, afterCursor.toString(), limit],
      );
      return result.rows.map(mapRaw);
    },

    async earliestEventId(workspaceId) {
      const result = await exec.query<{ min: string | null }>(
        `SELECT MIN(event_id)::text AS min FROM events WHERE workspace_id = $1`,
        [workspaceId],
      );
      const value = result.rows[0]?.min;
      return value == null ? null : BigInt(value);
    },

    async latestAllocatedEventId(workspaceId) {
      const result = await exec.query<{ next: string | null }>(
        `SELECT next_event_id::text AS next FROM event_counters WHERE workspace_id = $1`,
        [workspaceId],
      );
      const value = result.rows[0]?.next;
      return value == null ? 0n : BigInt(value) - 1n;
    },
  };
}

/**
 * Journal-row → contract-envelope mapping (T11).
 *
 * Every row leaves the application layer only after it has been validated against the
 * canonical `event.schema.json` (via the generated `parseEvent`). There is no cast:
 * if a journal row drifts from the contract the validator throws, which is the honest
 * failure mode rather than shipping an unvalidated payload to the browser.
 */
import { parseEvent } from '@redai/contracts';
import type { EventEnvelope, EventRow } from './ports.js';

/**
 * Map a raw journal row onto the contract envelope and validate it. `eventId` (a
 * bigint cursor) becomes the decimal `Counter` string the contract requires, and
 * `createdAt` becomes an RFC3339 `date-time`.
 */
export function toEnvelope(row: EventRow): EventEnvelope {
  const candidate = {
    schema_version: '1.0',
    event_id: row.eventId.toString(),
    workspace_id: row.workspaceId,
    project_id: row.projectId,
    run_id: row.runId,
    type: row.eventType,
    created_at: row.createdAt.toISOString(),
    data: row.payload,
  };
  return parseEvent(candidate);
}

/**
 * Build a validated `stream.cursor` control envelope. The transport emits this when a
 * project/run filter has advanced the cursor past events the subscriber may not see,
 * so a reconnect resumes after the skipped ids instead of rescanning them — without
 * ever revealing another project's payload (docs/06 §8). `event_id` carries the new
 * cursor position; `project_id`/`run_id` are null because this frame belongs to no
 * single resource.
 */
export function cursorEnvelope(workspaceId: string, cursor: bigint): EventEnvelope {
  const value = cursor.toString();
  return parseEvent({
    schema_version: '1.0',
    event_id: value,
    workspace_id: workspaceId,
    project_id: null,
    run_id: null,
    type: 'stream.cursor',
    created_at: new Date().toISOString(),
    data: { cursor: value },
  });
}

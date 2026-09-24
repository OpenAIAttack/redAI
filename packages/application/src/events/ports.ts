/**
 * Ports for the workspace event stream (T11).
 *
 * The stream reads the durable `events` journal (docs/05 §events) strictly after a
 * per-workspace, commit-ordered cursor (`event_id`) and maps every row onto the
 * canonical `event.schema.json` envelope. The journal is the source of truth;
 * `LISTEN/NOTIFY` is only a wake signal and losing a notify must never lose an event
 * (docs/06 §8), so the reader is pull-based and the notify layer is a separate,
 * best-effort port owned by the transport.
 */
import type { Event } from '@redai/contracts';

/**
 * A validated SSE payload. This is exactly the canonical contract `Event` union — the
 * stream never invents a shape; {@link EventJournalReader} rows are mapped and then
 * validated against `event.schema.json` before they leave the application layer.
 */
export type EventEnvelope = Event;

/** A raw row read from the `events` journal. `eventId` is the commit-ordered cursor. */
export interface EventRow {
  workspaceId: string;
  eventId: bigint;
  projectId: string | null;
  runId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

/** Optional narrowing of the (workspace-wide) stream to a single project and/or run. */
export interface EventFilter {
  projectId?: string | null;
  runId?: string | null;
}

/**
 * Port: read the durable event journal for one workspace. DB-agnostic so the service
 * is unit-testable with an in-memory fake; the production adapter is
 * `createDbEventJournalReader` over `@redai/db`.
 */
export interface EventJournalReader {
  /**
   * Committed rows with `event_id` strictly greater than `afterCursor`, ascending,
   * at most `limit`. Ascending order is load-bearing: the caller stops at the first
   * gap so it never advances past an id a not-yet-committed lower transaction will
   * still fill (commit-ordering guarantee, INV-009 / docs/06 §8).
   */
  readAfter(workspaceId: string, afterCursor: bigint, limit: number): Promise<EventRow[]>;
  /** Smallest surviving `event_id`, or `null` when the workspace journal is empty. */
  earliestEventId(workspaceId: string): Promise<bigint | null>;
  /**
   * Highest `event_id` ever ALLOCATED for the workspace (`next_event_id - 1`), or `0n`
   * when the workspace has never appended an event. Used to reject a cursor that
   * points past anything the workspace has committed (a "future" cursor).
   */
  latestAllocatedEventId(workspaceId: string): Promise<bigint>;
}

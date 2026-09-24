/**
 * EventStream — the workspace event-stream read model (T11).
 *
 * Responsibilities (all pure/read-only; the transport owns sockets and NOTIFY):
 *   - Read the journal strictly after a commit-ordered cursor and stop at the first
 *     gap, so a consumer NEVER advances past an `event_id` that a not-yet-committed
 *     lower transaction will still fill (commit-ordering guarantee). Because the
 *     `event_counters` row lock is held to COMMIT, a visible gap means a lower id is
 *     mid-commit and will appear next; the contiguity stop waits for it rather than
 *     skipping ahead.
 *   - Map + validate each row onto the `event.schema.json` envelope.
 *   - Apply an optional project/run filter, while still advancing the cursor across
 *     non-matching events (the transport emits `stream.cursor` for the skipped span).
 *   - Classify a requested cursor as ok / future / expired, so an expired cursor
 *     (older than what retention still holds) yields a resync signal, not a silent
 *     skip (docs/06 §8, events retained 30 days).
 */
import { toEnvelope } from './envelope.js';
import type { EventEnvelope, EventFilter, EventJournalReader, EventRow } from './ports.js';

/** Default max rows fetched per read cycle. Bounds a single query, not the stream. */
export const DEFAULT_BATCH_LIMIT = 256;

/** How a requested cursor relates to what the workspace journal currently holds. */
export type CursorClass = 'ok' | 'future' | 'expired';

export interface ReadAfterResult {
  /** Matched, validated envelopes in ascending, gap-free order. */
  events: EventEnvelope[];
  /**
   * The advanced cursor: the last CONTIGUOUS `event_id` consumed from `afterCursor`
   * (regardless of whether it matched the filter). Equal to `afterCursor` when the
   * next id is not yet available (empty journal tail or an in-flight lower id).
   */
  cursor: bigint;
  /**
   * True when the cursor advanced past events that the filter dropped, so no emitted
   * envelope carries the new position. The transport then emits a `stream.cursor`
   * frame so the subscriber's `Last-Event-ID` still moves forward.
   */
  advancedPastFiltered: boolean;
}

function matchesFilter(row: EventRow, filter: EventFilter): boolean {
  if (filter.projectId != null && row.projectId !== filter.projectId) return false;
  if (filter.runId != null && row.runId !== filter.runId) return false;
  return true;
}

export class EventStream {
  private readonly reader: EventJournalReader;

  public constructor(reader: EventJournalReader) {
    this.reader = reader;
  }

  /**
   * Classify a requested cursor before streaming:
   *   - `future`  — beyond anything the workspace has committed (client bug / wrong
   *     workspace): the transport rejects with 400 rather than blocking forever.
   *   - `expired` — an event at `cursor + 1` was purged by retention (the earliest
   *     surviving id is higher): the transport signals resync-from-snapshot.
   *   - `ok`      — safe to stream after.
   */
  public async classifyCursor(workspaceId: string, cursor: bigint): Promise<CursorClass> {
    if (cursor < 0n) return 'future';
    const latest = await this.reader.latestAllocatedEventId(workspaceId);
    if (cursor > latest) return 'future';
    const earliest = await this.reader.earliestEventId(workspaceId);
    // earliest is null only when the journal is empty; then cursor must be 0 (== latest)
    // to have passed the future check, so there is nothing expired.
    if (earliest !== null && cursor + 1n < earliest) return 'expired';
    return 'ok';
  }

  /**
   * Read the next contiguous, filtered slice after `afterCursor`. Never skips a gap:
   * iteration stops at the first id that is not exactly `previous + 1`.
   */
  public async readAfter(
    workspaceId: string,
    afterCursor: bigint,
    filter: EventFilter = {},
    limit: number = DEFAULT_BATCH_LIMIT,
  ): Promise<ReadAfterResult> {
    const rows = await this.reader.readAfter(workspaceId, afterCursor, limit);

    let expected = afterCursor + 1n;
    const contiguous: EventRow[] = [];
    for (const row of rows) {
      if (row.eventId === expected) {
        contiguous.push(row);
        expected += 1n;
      } else {
        // Gap: a lower id is still mid-commit (or this batch simply started past a
        // hole). Do NOT consume the higher id — wait for the lower one to appear.
        break;
      }
    }

    const cursor = contiguous.length > 0 ? contiguous[contiguous.length - 1]!.eventId : afterCursor;
    const matched = contiguous.filter((row) => matchesFilter(row, filter));
    const events = matched.map(toEnvelope);

    const advancedPastFiltered = cursor > afterCursor && matched.length < contiguous.length;
    return { events, cursor, advancedPastFiltered };
  }
}

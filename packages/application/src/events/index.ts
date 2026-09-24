/**
 * @redai/application events barrel — the workspace event-stream read model (T11).
 *
 * Exposed as the `@redai/application/events` subpath export. The API transport
 * (`apps/api/src/events`) imports {@link EventStream} + the DB reader and owns the
 * SSE sockets, `LISTEN/NOTIFY` wakeups, heartbeats and backpressure; this package
 * stays free of HTTP and `pg` wiring and only reads + validates the journal.
 */
export { EventStream, DEFAULT_BATCH_LIMIT } from './service.js';
export type { CursorClass, ReadAfterResult } from './service.js';

export { createDbEventJournalReader } from './dbReader.js';

export { toEnvelope, cursorEnvelope } from './envelope.js';

export type { EventEnvelope, EventRow, EventFilter, EventJournalReader } from './ports.js';

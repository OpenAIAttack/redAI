/**
 * apps/api events barrel. `registerEvents` mounts the SSE route; the compose helpers
 * build the production read model + NOTIFY source from a pg pool (server.ts wiring).
 */
import { EventStream, createDbEventJournalReader } from '@redai/application/events';
import type { Pool } from '@redai/db';
import { createPgNotifySource } from './notify.js';

export { registerEvents } from './plugin.js';
export type { EventsPluginDeps, EventsPluginOptions, EventsOwnerContext } from './plugin.js';
export { createPgNotifySource } from './notify.js';
export type { NotifySource } from './notify.js';
export { SseSession } from './sse.js';
export type { SseWriter, SseSessionOptions, ResyncReason } from './sse.js';

/** Compose the workspace event-stream read model from a pg pool. */
export function createDbEventStream(pool: Pool): EventStream {
  return new EventStream(createDbEventJournalReader(pool));
}

/** Compose the NOTIFY wake source from a pg pool. */
export function createEventNotifySource(pool: Pool): ReturnType<typeof createPgNotifySource> {
  return createPgNotifySource(pool);
}

/**
 * apps/api runs barrel. `registerRuns` mounts the Fastify routes;
 * `createDbRunsService` composes the production Ask use-case service from a pg pool.
 *
 * The API surface only CREATES runs and READS status/history — it never runs the
 * durable step (that is the runtime's job, `apps/runtime/src/ask`). So the provider
 * resolver injected here is a stub that throws if ever called; the real resolver
 * (`resolveCredential` + T08) is composed in the runtime. The DB context builder is
 * harmless to include and keeps the service construction uniform.
 */
import {
  AskService,
  createDbMessagesRepository,
  createDbAskContextBuilder,
  type ProviderResolver,
} from '@redai/application/messages';
import type { Pool } from '@redai/db';

export { registerRuns } from './plugin.js';
export type { RunsPluginDeps, OwnerContext } from './plugin.js';
export { isMessagesError, sendMessagesError } from './errors.js';

/** A resolver that fails loudly: the API never steps a run, so this must not be called. */
const apiNoStepResolver: ProviderResolver = {
  async resolve() {
    throw new Error('provider resolution is a runtime concern, not an API concern');
  },
};

/** Compose the DB-backed Ask use-case service for the API (create + status + history). */
export function createDbRunsService(pool: Pool): AskService {
  return new AskService({
    repo: createDbMessagesRepository(pool),
    context: createDbAskContextBuilder(pool),
    provider: apiNoStepResolver,
  });
}

/**
 * apps/api artifacts barrel. `registerArtifacts` mounts the Fastify routes;
 * `createDbArtifactsService` composes the production use-case service from a pg pool and
 * the configured ObjectStore root.
 *
 * The coordinator calls `registerArtifacts(app, { service, authenticate, ... })` from
 * the server wiring, injecting the owner-auth guard. Runtime use-case values come from
 * the `@redai/application/artifacts` subpath export (D08); bytes come from
 * `@redai/storage` via the composed service.
 */
import {
  ArtifactsService,
  createDbArtifactsRepository,
  createDbProjectGate,
  createLocalObjectStore,
} from '@redai/application/artifacts';
import type { Pool } from '@redai/db';

export { registerArtifacts } from './plugin.js';
export type { ArtifactsPluginDeps, OwnerContext } from './plugin.js';
export { sendArtifactsError, isArtifactsError } from './errors.js';

/** Compose the DB + local-ObjectStore artifact use-case service for production wiring. */
export function createDbArtifactsService(pool: Pool, objectStoreRoot: string): ArtifactsService {
  return new ArtifactsService({
    repo: createDbArtifactsRepository(pool),
    projects: createDbProjectGate(pool),
    store: createLocalObjectStore(objectStoreRoot),
  });
}

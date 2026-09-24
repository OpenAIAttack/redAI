/**
 * apps/api projects barrel. `registerProjects` mounts the Fastify routes;
 * `createDbProjectsService` composes the production use-case service from a pg pool.
 *
 * The coordinator calls `registerProjects(app, { service, authenticate, ... })` from
 * the server wiring, injecting the owner-auth guard. Runtime use-case values are
 * imported from the application projects source (the coordinator re-exports them via
 * the `@redai/application` barrel, which this task must not edit).
 */
import { ProjectsService, createDbProjectsRepository } from '@redai/application/projects';
import type { Pool } from '@redai/db';

export { registerProjects } from './plugin.js';
export type { ProjectsPluginDeps, OwnerContext } from './plugin.js';
export { sendProjectsError, isProjectsError } from './errors.js';

/** Compose the DB-backed projects use-case service for production wiring. */
export function createDbProjectsService(pool: Pool): ProjectsService {
  return new ProjectsService({ repo: createDbProjectsRepository(pool) });
}

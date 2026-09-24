/**
 * apps/api scope barrel — the owner-authenticated Fastify plugin for DNS proofs,
 * scope versions and authorization grants (T12).
 *
 * `registerScope(app, deps)` mounts the routes with the owner guard, CSRF check and
 * trusted DNS resolver injected. The scope SERVICE is injected too (typed by the
 * structural {@link ScopePluginService}); the DB-composed service factory
 * `createDbScopeService(pool)` lives in `@redai/application/scope` (NOT here) so this
 * package builds WITHOUT importing that subpath, which the coordinator wires into the
 * `@redai/application` `exports` map. See release-evidence/T12 for the exact server.ts
 * wiring the coordinator must add.
 */
export { registerScope } from './plugin.js';
export type {
  ScopePluginDeps,
  ScopePluginService,
  OwnerContext,
  InjectedDnsResolver,
  DnsProofView,
  IssueChallengeView,
  ScopeVersionView,
  GrantView,
} from './plugin.js';
export { isScopeError, sendScopeError } from './errors.js';

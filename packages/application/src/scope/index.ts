/**
 * @redai/application scope barrel — DNS-proof, scope-version and grant use cases (T12).
 *
 * The coordinator adds a `./scope` subpath to the package `exports` map (this task
 * must not edit that shared file) and re-exports what it needs. The API layer imports
 * the plugin from `@redai/api` and the DB-composed service from THIS module via
 * `@redai/application/scope`; only the DB adapter here reaches into `@redai/db`.
 *
 * `createDbScopeService(pool)` lives here (rather than in the API package) so the API
 * scope plugin needs no `@redai/application/scope` import at build time — it takes the
 * service injected, exactly like the projects plugin takes `ProjectsService`.
 */
import type { Pool } from '@redai/db';
import { createDbScopeRepository } from './dbRepository.js';
import { ScopeService } from './service.js';

export { ScopeService } from './service.js';
export type { ScopeServiceDeps, CreateGrantInput, IssueChallengeResult } from './service.js';
export { CHALLENGE_TOKEN_BYTES, CHALLENGE_TTL_MS, CHALLENGE_LABEL } from './service.js';

export {
  ScopeError,
  InvalidRootError,
  PublicSuffixRootError,
  DnsProofNotFoundError,
  DnsProofExpiredError,
  DnsProofNotPendingError,
  DnsProofMismatchError,
  InvalidScopeError,
  ScopeVersionNotFoundError,
  GrantNotFoundError,
  GrantProofRequiredError,
  GrantProofScopeMismatchError,
  LabAttestationMisuseError,
  GrantAlreadyRevokedError,
} from './errors.js';
export type { ScopeErrorCode } from './errors.js';

export { createDbScopeRepository } from './dbRepository.js';
export { InMemoryScopeRepository, StaticDnsResolver } from './memoryRepository.js';

export type {
  Clock,
  RandomSource,
  DnsResolver,
  DnsProofStatus,
  GrantStatus,
  AuthorizationBasis,
  DnsProofRecord,
  ScopeVersionRecord,
  GrantRecord,
  LiveGrantStatus,
  ScopeRepository,
} from './ports.js';

/** Compose the DB-backed scope use-case service for production wiring. */
export function createDbScopeService(pool: Pool): ScopeService {
  return new ScopeService({ repo: createDbScopeRepository(pool) });
}

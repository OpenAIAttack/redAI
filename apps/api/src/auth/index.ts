/**
 * apps/api auth barrel. `registerAuth` wires the Fastify routes; `buildAuthConfig`
 * derives the HTTP config from the process env; `createDbAuthService` composes the
 * production service from a `pg` pool.
 */
import { AuthService, createDbAuthRepository, systemClock } from '@redai/application';
import type { Pool } from '@redai/db';
import type { AuthHttpConfig } from './plugin.js';

export { registerAuth } from './plugin.js';
export type { AuthHttpConfig, AuthPluginDeps } from './plugin.js';
export { LoginRateLimiter, DEFAULT_RATE_LIMIT } from './rateLimit.js';
export type { RateLimitConfig } from './rateLimit.js';
export { cookieNames } from './cookies.js';

/** Compose the DB-backed AuthService for production wiring. */
export function createDbAuthService(pool: Pool): AuthService {
  return new AuthService({ repo: createDbAuthRepository(pool), clock: systemClock });
}

/** Parse the auth HTTP config from environment values. */
export function buildAuthConfig(source: {
  cookieSecure: boolean;
  allowedOrigins: string[];
}): AuthHttpConfig {
  return {
    cookieSecure: source.cookieSecure,
    allowedOrigins: source.allowedOrigins,
  };
}

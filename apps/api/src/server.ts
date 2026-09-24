import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService, systemClock, type Clock } from '@redai/application';
import { createPool, type Pool } from '@redai/db';
import { loadApiEnv, type ApiEnv } from './env.js';
import { readinessFromEnv } from './health.js';
import { buildAuthConfig, createDbAuthService, registerAuth } from './auth/index.js';
import type { AuthHttpConfig } from './auth/plugin.js';

export interface BuildServerOptions {
  env?: ApiEnv;
  /**
   * Inject an auth service (tests use an in-memory-backed one). When omitted and a
   * `DATABASE_URL` is configured, a DB-backed service is composed from a pool that
   * the server owns and closes on shutdown.
   */
  auth?: {
    service: AuthService;
    clock?: Clock;
    config?: Partial<AuthHttpConfig>;
  };
}

/**
 * Build the Fastify instance without listening — used by tests via `inject`.
 * Domain handlers that do not exist yet return 501 Not Implemented rather than
 * faking success (T03 acceptance for the wider API surface).
 */
export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const env = opts.env ?? loadApiEnv();
  const app = Fastify({ logger: false });

  // Liveness: the process is up and serving. Always 200 when reachable.
  app.get('/api/health/live', async () => ({ status: 'live' }));

  // Readiness: distinguishes unconfigured / degraded / ready.
  app.get('/api/health/ready', async (_req, reply) => {
    const result = readinessFromEnv(env);
    const httpStatus = result.status === 'ready' ? 200 : 503;
    return reply.code(httpStatus).send({
      status: result.status,
      components: result.components,
    });
  });

  const defaultConfig: AuthHttpConfig = buildAuthConfig({
    cookieSecure: env.cookieSecure,
    allowedOrigins: env.allowedOrigins,
  });

  if (opts.auth) {
    registerAuth(app, {
      auth: opts.auth.service,
      clock: opts.auth.clock ?? systemClock,
      config: { ...defaultConfig, ...opts.auth.config },
    });
  } else if (env.databaseUrl) {
    const pool: Pool = createPool({
      connectionString: env.databaseUrl,
      applicationName: 'redai-api',
    });
    app.addHook('onClose', async () => {
      await pool.end();
    });
    registerAuth(app, {
      auth: createDbAuthService(pool),
      clock: systemClock,
      config: defaultConfig,
    });
  }
  // Without a database and without an injected service, auth routes are not
  // mounted (the install is unconfigured); health still reports that state.

  return app;
}

export function getEnv(): ApiEnv {
  return loadApiEnv();
}

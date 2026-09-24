import Fastify, { type FastifyInstance } from 'fastify';
import { loadApiEnv, type ApiEnv } from './env.js';
import { readinessFromEnv } from './health.js';

export interface BuildServerOptions {
  env?: ApiEnv;
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

  return app;
}

export function getEnv(): ApiEnv {
  return loadApiEnv();
}

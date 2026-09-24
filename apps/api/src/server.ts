import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService, systemClock, type Clock } from '@redai/application';
import {
  SettingsService,
  createDbSettingsRepository,
  createFileMasterKeyProvider,
} from '@redai/application/settings';
import {
  WorkerIdentityService,
  createDbWorkerIdentityRepository,
} from '@redai/application/workerIdentity';
import { createPool, type Pool } from '@redai/db';
import { loadApiEnv, type ApiEnv } from './env.js';
import { readinessFromEnv } from './health.js';
import { buildAuthConfig, createDbAuthService, registerAuth } from './auth/index.js';
import { createOwnerGuard } from './auth/ownerGuard.js';
import type { AuthHttpConfig } from './auth/plugin.js';
import { createDbProjectsService, registerProjects } from './projects/index.js';
import { createDbArtifactsService, registerArtifacts } from './artifacts/index.js';
import { createDbRunsService, registerRuns } from './runs/index.js';
import { registerSettings } from './settings/index.js';
import { registerWorkerIdentity } from './worker/index.js';
import { generateInstallationSigningKey } from './installation/signingKey.js';

export interface BuildServerOptions {
  env?: ApiEnv;
  /**
   * Inject an auth service (tests use an in-memory-backed one). When omitted and a
   * `DATABASE_URL` is configured, a DB-backed service is composed from a pool that
   * the server owns and closes on shutdown, and the full owner + worker API surface
   * (settings, projects, worker identity) is mounted.
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

    const authService = createDbAuthService(pool);
    registerAuth(app, { auth: authService, clock: systemClock, config: defaultConfig });
    const ownerGuard = createOwnerGuard(authService, defaultConfig);

    // Projects / Chats / Notes (owner-authenticated).
    registerProjects(app, {
      service: createDbProjectsService(pool),
      authenticate: (req) => ownerGuard.authenticate(req),
      authorizeMutation: (req, ctx) => ownerGuard.authorizeMutation(req, ctx),
    });

    // Runs (Ask) + chat message history (owner-authenticated). Create is
    // Idempotency-Key protected; the durable Ask step runs in the separate runtime
    // process (apps/runtime/src/ask), which composes the provider from resolveCredential.
    registerRuns(app, {
      service: createDbRunsService(pool),
      authenticate: (req) => ownerGuard.authenticate(req),
      authorizeMutation: (req, ctx) => ownerGuard.authorizeMutation(req, ctx),
    });

    // Artifacts (owner-authenticated staged upload → finalize, download, safe preview).
    // Only mounted once the local ObjectStore root is configured; its absence is an
    // honest "unconfigured" state, not a crash (D03).
    if (env.objectStoreRoot) {
      registerArtifacts(app, {
        service: createDbArtifactsService(pool, env.objectStoreRoot),
        authenticate: (req) => ownerGuard.authenticate(req),
        authorizeMutation: (req, ctx) => ownerGuard.authorizeMutation(req, ctx),
      });
    }

    // Worker enrollment & identity (owner plane + /worker/v1 bearer plane).
    const installationKey = generateInstallationSigningKey();
    registerWorkerIdentity(app, {
      service: new WorkerIdentityService({ repo: createDbWorkerIdentityRepository(pool) }),
      resolveOwner: (req) => ownerGuard.authenticate(req),
      config: {
        allowedOrigins: env.allowedOrigins,
        trustedSigningKeys: [installationKey.trusted],
      },
    });

    // Secret vault + settings: only mounted once a master key file is configured,
    // because the vault cannot be unlocked without it. Absence is an honest
    // "unconfigured" state, not a crash.
    if ((process.env.REDAI_MASTER_KEY_FILE ?? '') !== '') {
      registerSettings(app, {
        service: new SettingsService({
          repo: createDbSettingsRepository(pool),
          masterKeys: createFileMasterKeyProvider(),
        }),
        ownerAuth: {
          authenticate: (req) => ownerGuard.authenticate(req),
          authorizeMutation: (req, ctx) => ownerGuard.authorizeMutation(req, ctx),
        },
      });
    }
  }
  // Without a database and without an injected service, the API surface is not
  // mounted (the install is unconfigured); health still reports that state.

  return app;
}

export function getEnv(): ApiEnv {
  return loadApiEnv();
}

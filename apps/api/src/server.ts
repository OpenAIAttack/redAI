import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService, systemClock, type Clock } from '@redai/application';
import {
  SettingsService,
  ProviderProbeService,
  createDbProbeStore,
  createDbSettingsRepository,
  createFileMasterKeyProvider,
  MasterKeyUnavailableError,
} from '@redai/application/settings';
import {
  WorkerIdentityService,
  createDbWorkerIdentityRepository,
} from '@redai/application/workerIdentity';
import { createPool, pingDatabase, type Pool } from '@redai/db';
import { loadApiEnv, type ApiEnv } from './env.js';
import { checkReadiness, probeObjectStore, type ReadinessProbes } from './health.js';
import { buildAuthConfig, createDbAuthService, registerAuth } from './auth/index.js';
import { createOwnerGuard } from './auth/ownerGuard.js';
import type { AuthHttpConfig } from './auth/plugin.js';
import { createDbProjectsService, registerProjects } from './projects/index.js';
import { createDbArtifactsService, registerArtifacts } from './artifacts/index.js';
import { registerSettings } from './settings/index.js';
import { registerWorkerIdentity } from './worker/index.js';
import { generateInstallationSigningKey } from './installation/signingKey.js';

export interface BuildServerOptions {
  env?: ApiEnv;
  /** Inject only in tests; production probes actual configured dependencies. */
  readinessProbes?: ReadinessProbes;
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
  // A small dedicated pool bounds health traffic independently of application load.
  const healthPool =
    env.databaseUrl && !opts.readinessProbes
      ? createPool({
          connectionString: env.databaseUrl,
          max: 1,
          connectionTimeoutMillis: 1000,
          queryTimeoutMillis: 1000,
          applicationName: 'redai-health',
        })
      : undefined;
  if (healthPool) app.addHook('onClose', () => healthPool.end());
  const probes = opts.readinessProbes ?? {
    database: () => (healthPool ? pingDatabase(healthPool) : Promise.resolve(false)),
    objectStore: () =>
      env.objectStoreRoot ? probeObjectStore(env.objectStoreRoot) : Promise.resolve(false),
  };
  // Coalesce concurrent health requests so they cannot multiply filesystem probes.
  let pendingReadiness: ReturnType<typeof checkReadiness> | undefined;

  // Liveness: the process is up and serving. Always 200 when reachable.
  app.get('/api/health/live', async () => ({ status: 'live' }));

  // Readiness: distinguishes unconfigured / degraded / ready.
  app.get('/api/health/ready', async (_req, reply) => {
    pendingReadiness ??= checkReadiness(env, probes).finally(() => {
      pendingReadiness = undefined;
    });
    const result = await pendingReadiness;
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
    {
      const settingsService = new SettingsService({
        repo: createDbSettingsRepository(pool),
        masterKeys: process.env.REDAI_MASTER_KEY_FILE
          ? createFileMasterKeyProvider()
          : {
              activeKey() {
                throw new MasterKeyUnavailableError('Secret store is locked.');
              },
              keyById() {
                throw new MasterKeyUnavailableError('Secret store is locked.');
              },
            },
      });
      registerSettings(app, {
        service: settingsService,
        probeService: new ProviderProbeService({
          settings: settingsService,
          store: createDbProbeStore(pool),
          approvedLocalBaseUrls: (process.env.REDAI_LOCAL_MODEL_BASE_URLS ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
        ownerAuth: {
          authenticate: (req) => ownerGuard.authenticate(req),
          authorizeMutation: (req, ctx) => ownerGuard.authorizeMutation(req, ctx),
        },
      });
    }
  }
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/v1/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  // Without a database and without an injected service, the API surface is not
  // mounted (the install is unconfigured); health still reports that state.

  return app;
}

export function getEnv(): ApiEnv {
  return loadApiEnv();
}

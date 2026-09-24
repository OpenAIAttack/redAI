/**
 * apps/api worker-identity barrel. `registerWorkerIdentity` wires the Fastify routes
 * for the owner enrollment-token API and the `/worker/v1/*` worker plane. The
 * concrete `WorkerIdentityService` and owner-auth resolver are injected by the
 * server wiring (owned by the coordinator; T15 does not edit `server.ts`).
 */
export { registerWorkerIdentity } from './plugin.js';
export type {
  WorkerIdentityPluginDeps,
  WorkerIdentityHttpConfig,
  WorkerIdentityApi,
  OwnerContext,
  WorkerContext,
  TrustedSigningKey,
} from './plugin.js';

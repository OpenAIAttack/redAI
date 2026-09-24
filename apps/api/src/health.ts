import { computeReadiness, type ComponentCheck, type ReadinessResult } from '@redai/domain';
import type { ApiEnv } from './env.js';

/**
 * Build the component list from configuration.
 *
 * M0 reports readiness from *configuration presence*. Deep liveness probes
 * (actually connecting to PostgreSQL / the ObjectStore) are wired in when those
 * components land (T02 DB, T07 storage) and will set `healthy` from a real
 * check instead of mirroring `configured`. This is intentionally honest: the
 * skeleton never claims a component is healthy that it has not verified.
 */
export function componentsFromEnv(env: ApiEnv): ComponentCheck[] {
  const dbConfigured = env.databaseUrl !== undefined;
  const storeConfigured = env.objectStoreRoot !== undefined;
  return [
    { name: 'database', required: true, configured: dbConfigured, healthy: dbConfigured },
    { name: 'object_store', required: true, configured: storeConfigured, healthy: storeConfigured },
    {
      name: 'model_provider',
      required: false,
      configured: env.modelProviderConfigured,
      healthy: env.modelProviderConfigured,
    },
  ];
}

export function readinessFromEnv(env: ApiEnv): ReadinessResult {
  return computeReadiness(componentsFromEnv(env));
}

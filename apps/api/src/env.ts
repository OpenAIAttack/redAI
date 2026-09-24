/**
 * Environment validation for the API process.
 *
 * Fails fast with a clear message on invalid values. Absence of optional
 * integrations (database, object store, model provider) is NOT an error — it
 * makes the system report `unconfigured`, which is a distinct, expected state
 * during setup.
 */

export interface ApiEnv {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  /** Present once the owner has configured PostgreSQL (T02/T04). */
  readonly databaseUrl: string | undefined;
  /** Present once the owner has configured the local ObjectStore root (T07). */
  readonly objectStoreRoot: string | undefined;
  /** True once at least one model provider credential is configured (T05/T08). */
  readonly modelProviderConfigured: boolean;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid PORT: ${raw} (expected an integer 1–65535)`);
  }
  return n;
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const nodeEnvRaw = source.NODE_ENV ?? 'development';
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'test' && nodeEnvRaw !== 'production') {
    throw new Error(`Invalid NODE_ENV: ${nodeEnvRaw}`);
  }
  return {
    nodeEnv: nodeEnvRaw,
    host: source.API_HOST ?? '127.0.0.1',
    port: parsePort(source.API_PORT, 8787),
    databaseUrl: source.DATABASE_URL || undefined,
    objectStoreRoot: source.OBJECT_STORE_ROOT || undefined,
    modelProviderConfigured: (source.MODEL_PROVIDER_CONFIGURED ?? 'false') === 'true',
  };
}

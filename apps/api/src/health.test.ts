import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReadiness, probeObjectStore } from './health.js';
import { loadApiEnv } from './env.js';

describe('readiness probes', () => {
  it('checks real object-store IO and leaves no probe bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redai-health-'));
    try {
      expect(await probeObjectStore(root)).toBe(true);
      expect(await readdir(root)).toEqual([]);
      expect(await probeObjectStore(join(root, 'missing'))).toBe(false);
      await writeFile(join(root, 'file'), 'x');
      expect(await probeObjectStore(join(root, 'file'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('bounds hung dependencies and does not echo their exceptions', async () => {
    const env = loadApiEnv({ DATABASE_URL: 'postgres://unused', OBJECT_STORE_ROOT: '/unused' });
    const result = await checkReadiness(
      env,
      {
        database: () => new Promise(() => {}),
        objectStore: async () => {
          throw new Error('SECRET_CANARY');
        },
      },
      10,
    );
    expect(result.status).toBe('degraded');
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
  it('does not claim a configured but unprobed model is healthy', async () => {
    const env = loadApiEnv({
      DATABASE_URL: 'postgres://unused',
      OBJECT_STORE_ROOT: '/unused',
      MODEL_PROVIDER_CONFIGURED: 'true',
    });
    const result = await checkReadiness(env, {
      database: async () => true,
      objectStore: async () => true,
    });
    expect(result.status).toBe('degraded');
    expect(result.components.find((c) => c.name === 'model_provider')?.healthy).toBe(false);
  });
});

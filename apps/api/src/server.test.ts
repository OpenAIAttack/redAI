import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { loadApiEnv } from './env.js';

const baseEnv = { NODE_ENV: 'test' as const };

describe('health endpoints', () => {
  it('does not claim readiness merely because configuration exists', async () => {
    const app = buildServer({
      env: loadApiEnv({
        ...baseEnv,
        DATABASE_URL: 'postgres://127.0.0.1:1/redai',
        OBJECT_STORE_ROOT: '/nonexistent/redai-store',
      }),
    });
    try {
      const res = await app.inject('/api/health/ready');
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('degraded');
      expect(res.json().components.filter((c: { healthy: boolean }) => c.healthy)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('/api/health/live returns 200 live', async () => {
    const app = buildServer({ env: loadApiEnv(baseEnv) });
    const res = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'live' });
    await app.close();
  });

  it('/api/health/ready reports unconfigured (503) with no database', async () => {
    const app = buildServer({ env: loadApiEnv(baseEnv) });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unconfigured');
    await app.close();
  });

  it('/api/health/ready reports ready (200) only after successful probes', async () => {
    const app = buildServer({
      readinessProbes: { database: async () => true, objectStore: async () => true },
      env: loadApiEnv({
        ...baseEnv,
        DATABASE_URL: 'postgres://localhost/redai',
        OBJECT_STORE_ROOT: '/var/lib/redai/objects',
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await app.close();
  });
});

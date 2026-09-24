import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { loadApiEnv } from './env.js';

const baseEnv = { NODE_ENV: 'test' as const };

describe('health endpoints', () => {
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

  it('/api/health/ready reports ready (200) when required components configured', async () => {
    const app = buildServer({
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

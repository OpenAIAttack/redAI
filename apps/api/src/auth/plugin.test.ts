import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AuthService,
  InMemoryAuthRepository,
  type Clock,
  type PasswordHasher,
  type RandomSource,
} from '@redai/application';
import { buildServer } from '../server.js';
import { loadApiEnv } from '../env.js';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:3000';

class MockClock implements Clock {
  public constructor(private ms = 1_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
}

const fakeHasher: PasswordHasher = {
  hash: (plain) => Promise.resolve(`fake$${plain}`),
  verify: (plain, stored) => Promise.resolve(stored === `fake$${plain}`),
};

class SeqRandom implements RandomSource {
  private n = 0;
  token(): string {
    this.n += 1;
    return `token-${this.n}-0123456789abcdef0123456789abcdef`;
  }
  recoveryCode(): string {
    this.n += 1;
    return `RECOVERY-${this.n}`;
  }
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

async function setup(): Promise<{ app: FastifyInstance }> {
  const repo = new InMemoryAuthRepository();
  const clock = new MockClock();
  const service = new AuthService({ repo, clock, hasher: fakeHasher, random: new SeqRandom() });
  await service.bootstrapOwner({ username: 'owner', password: 'correct-horse-battery' });
  const app = buildServer({
    env: loadApiEnv({ NODE_ENV: 'test' }),
    auth: { service, clock, config: { cookieSecure: false, allowedOrigins: [ORIGIN] } },
  });
  return { app };
}

interface InjectCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
}

function cookieBy(res: { cookies: InjectCookie[] }, name: string): InjectCookie | undefined {
  return res.cookies.find((c) => c.name === name);
}

async function login(app: FastifyInstance): Promise<{ cookieHeader: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
    payload: { username: 'owner', password: 'correct-horse-battery' },
  });
  const session = cookieBy(res, 'redai_session')!;
  const csrf = cookieBy(res, 'redai_csrf')!;
  return {
    cookieHeader: `redai_session=${session.value}; redai_csrf=${csrf.value}`,
    csrf: csrf.value,
  };
}

describe('POST /api/v1/auth/login', () => {
  it('sets an HttpOnly session cookie and a readable CSRF cookie', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
      payload: { username: 'owner', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(200);
    const session = cookieBy(res, 'redai_session');
    const csrf = cookieBy(res, 'redai_csrf');
    expect(session?.httpOnly).toBe(true);
    expect(csrf?.httpOnly).toBeFalsy();
    const body = res.json();
    expect(body.username).toBe('owner');
    expect(body.csrf_token).toBe(csrf?.value);
    expect(body.setup_complete).toBe(true);
    await app.close();
  });

  it('rejects a foreign Origin', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://evil.example', host: HOST, 'content-type': 'application/json' },
      payload: { username: 'owner', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
    await app.close();
  });

  it('rejects a missing Origin', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: { username: 'owner', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns a generic 401 on a wrong password', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
      payload: { username: 'owner', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('trips the rate limit after repeated failures', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
        payload: { username: 'owner', password: 'wrong-password' },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });

  it('rejects a malformed body with 422', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
      payload: { username: 'owner' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe('owner endpoint guard', () => {
  it('rejects a worker-style bearer credential (no owner session cookie)', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization: 'Bearer worker.some-opaque-worker-credential' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /session returns the profile for a valid session', async () => {
    const { app } = await setup();
    const { cookieHeader } = await login(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('owner');
    await app.close();
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('rejects a mutation with a missing CSRF token', async () => {
    const { app } = await setup();
    const { cookieHeader } = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN, host: HOST, cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
    await app.close();
  });

  it('revokes the session with a valid CSRF token', async () => {
    const { app } = await setup();
    const { cookieHeader, csrf } = await login(app);
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: ORIGIN, host: HOST, cookie: cookieHeader, 'x-csrf-token': csrf },
    });
    expect(out.statusCode).toBe(204);
    // The session no longer authenticates.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: cookieHeader },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });
});

describe('password change HTTP boundary', () => {
  it('requires CSRF, commits once, revokes all sessions and rejects stale credentials', async () => {
    const { app } = await setup();
    try {
      const signedIn = await login(app);
      const headers = {
        origin: ORIGIN,
        host: HOST,
        cookie: signedIn.cookieHeader,
        'idempotency-key': 'password-change-test',
      };
      const payload = {
        current_password: 'correct-horse-battery',
        new_password: 'new-correct-horse-battery',
      };
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers, payload }))
          .statusCode,
      ).toBe(403);
      const results = await Promise.all(
        [1, 2].map(() =>
          app.inject({
            method: 'POST',
            url: '/api/v1/auth/password',
            headers: { ...headers, 'x-csrf-token': signedIn.csrf },
            payload,
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/session',
            headers: { cookie: signedIn.cookieHeader },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('owner session management', () => {
  it('returns metadata only and lets owner revoke a chosen session', async () => {
    const { app } = await setup();
    try {
      const first = await login(app);
      const second = await login(app);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: { cookie: first.cookieHeader },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('csrf');
      expect(response.body).not.toContain('token-');
      const other = response.json().items.find((s: { current: boolean }) => !s.current);
      const revoke = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/sessions/${other.id}/revoke`,
        headers: {
          cookie: first.cookieHeader,
          origin: ORIGIN,
          host: HOST,
          'x-csrf-token': first.csrf,
        },
      });
      expect(revoke.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/session',
            headers: { cookie: second.cookieHeader },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/auth/sessions',
            headers: { authorization: 'Bearer worker-token' },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

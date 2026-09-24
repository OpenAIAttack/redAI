/**
 * Boundary tests for the worker-identity Fastify plugin. A bare Fastify instance is
 * wired to the REAL `WorkerIdentityService` (backed by the in-memory repository) plus
 * a fake owner-auth resolver, so the tests exercise the actual HTTP guards.
 *
 * The two cross-auth directions are the headline assertions (T15 required):
 *   - an owner session cannot authenticate a `/worker/v1` route, and
 *   - a worker bearer credential cannot authenticate an owner route.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { describe, expect, it, beforeEach } from 'vitest';
// Application source imported by relative path (same pattern as tests/integration/db):
// the package barrel does not yet re-export workerIdentity, and this avoids a build.
import { WorkerIdentityService } from '@redai/application/workerIdentity';
import { InMemoryWorkerIdentityRepository } from '@redai/application/workerIdentity';
import { registerWorkerIdentity, type OwnerContext } from './plugin.js';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:3000';
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-0000000000ff';

const SIGNING_KEYS = [
  {
    key_id: 'k1',
    algorithm: 'EdDSA' as const,
    public_key_base64url: 'AAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
];

/** Owner-auth fake: authenticates ONLY the owner session cookie, never a bearer. */
async function resolveOwner(req: FastifyRequest): Promise<OwnerContext | null> {
  const cookie = req.headers.cookie ?? '';
  if (/(?:^|;\s*)owner_session=valid(?:;|$)/.test(cookie)) {
    return { workspaceId: WORKSPACE, ownerId: OWNER };
  }
  return null;
}

async function build(): Promise<{ app: FastifyInstance }> {
  const repo = new InMemoryWorkerIdentityRepository();
  const service = new WorkerIdentityService({ repo });
  const app = Fastify({ logger: false });
  registerWorkerIdentity(app, {
    service,
    resolveOwner,
    config: { allowedOrigins: [ORIGIN], trustedSigningKeys: SIGNING_KEYS },
  });
  await app.ready();
  return { app };
}

const OWNER_HEADERS = { origin: ORIGIN, host: HOST, cookie: 'owner_session=valid' };

async function createEnrollmentToken(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/workers/enrollment-tokens',
    headers: OWNER_HEADERS,
    payload: { zone: 'lab-a', display_name: 'lab-worker' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().enrollment_token as string;
}

function enrollBody(token: string, workerId: string) {
  return {
    enrollment_token: token,
    worker_id: workerId,
    display_name: 'lab-worker',
    os: 'linux',
    arch: 'amd64',
    agent_version: '1.0.0',
    manifest_sha256: 'b'.repeat(64),
    capacity: 2,
  };
}

async function enroll(
  app: FastifyInstance,
  workerId = '00000000-0000-4000-8000-0000000000aa',
): Promise<{ credential: string; workerId: string }> {
  const token = await createEnrollmentToken(app);
  const res = await app.inject({
    method: 'POST',
    url: '/worker/v1/enroll',
    headers: { origin: ORIGIN, host: HOST },
    payload: enrollBody(token, workerId),
  });
  expect(res.statusCode).toBe(201);
  return { credential: res.json().worker_credential as string, workerId };
}

describe('worker-identity plugin — happy path', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await build());
  });

  it('owner mints a token, worker redeems it and authenticates on /worker/v1', async () => {
    const { credential } = await enroll(app);

    const identity = await app.inject({
      method: 'GET',
      url: '/worker/v1/identity',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().zone).toBe('lab-a');
    expect(identity.json().state).toBe('offline');
  });

  it('enrollment response carries installation id and trusted signing keys', async () => {
    const token = await createEnrollmentToken(app);
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/enroll',
      headers: { origin: ORIGIN, host: HOST },
      payload: enrollBody(token, '00000000-0000-4000-8000-0000000000ab'),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.installation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.trusted_signing_keys).toHaveLength(1);
    expect(body.worker_credential.length).toBeGreaterThanOrEqual(32);
  });

  it('rotates the credential; the new one authenticates', async () => {
    const { credential } = await enroll(app);
    const rotate = await app.inject({
      method: 'POST',
      url: '/worker/v1/credentials/rotate',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(rotate.statusCode).toBe(200);
    const next = rotate.json().worker_credential as string;
    expect(next).not.toBe(credential);

    const identity = await app.inject({
      method: 'GET',
      url: '/worker/v1/identity',
      headers: { authorization: `Bearer ${next}` },
    });
    expect(identity.statusCode).toBe(200);
  });
});

describe('worker-identity plugin — cross-auth is impossible (both directions)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await build());
  });

  it('an owner session cannot authenticate a /worker/v1 route', async () => {
    // A valid owner cookie, but no Bearer credential → the worker guard rejects.
    const res = await app.inject({
      method: 'GET',
      url: '/worker/v1/identity',
      headers: { cookie: 'owner_session=valid', origin: ORIGIN, host: HOST },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WORKER_UNAUTHENTICATED');
  });

  it('a worker credential cannot authenticate an owner route', async () => {
    const { credential } = await enroll(app);
    // Present the worker bearer (and no owner cookie) to an owner endpoint.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workers/enrollment-tokens',
      headers: { authorization: `Bearer ${credential}`, origin: ORIGIN, host: HOST },
      payload: { zone: 'lab-b' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('worker-identity plugin — enrollment single-use and revoke', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await build());
  });

  it('rejects a second redemption of the same enrollment token over HTTP', async () => {
    const token = await createEnrollmentToken(app);
    const first = await app.inject({
      method: 'POST',
      url: '/worker/v1/enroll',
      headers: { origin: ORIGIN, host: HOST },
      payload: enrollBody(token, '00000000-0000-4000-8000-0000000000c1'),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/worker/v1/enroll',
      headers: { origin: ORIGIN, host: HOST },
      payload: enrollBody(token, '00000000-0000-4000-8000-0000000000c2'),
    });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('ENROLLMENT_INVALID');
  });

  it('owner revoke invalidates the worker credential', async () => {
    const { credential, workerId } = await enroll(app);
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/workers/${workerId}/revoke`,
      headers: OWNER_HEADERS,
    });
    expect(revoke.statusCode).toBe(204);

    const identity = await app.inject({
      method: 'GET',
      url: '/worker/v1/identity',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(identity.statusCode).toBe(401);
  });

  it('rejects an owner mutation with no recognised Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workers/enrollment-tokens',
      headers: { origin: 'http://evil.example', host: HOST, cookie: 'owner_session=valid' },
      payload: { zone: 'lab-a' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('rejects a malformed enrollment body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/enroll',
      headers: { origin: ORIGIN, host: HOST },
      payload: { enrollment_token: 'short', worker_id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(422);
  });
});

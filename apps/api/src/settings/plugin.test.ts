import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SettingsService,
  InMemorySettingsRepository,
  StaticMasterKeyProvider,
} from '../../../../packages/application/src/settings/index.js';
import { registerSettings, type OwnerAuthContext, type SettingsAuth } from './plugin.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = '99999999-9999-4999-8999-999999999999';

/**
 * Fake injected owner-auth guard. A request is authenticated iff it carries the
 * `x-test-owner` header; a mutation is authorized iff it also carries `x-test-csrf:
 * ok`. This mirrors the real guard's contract (session cookie + Origin/CSRF) without
 * importing server internals.
 */
const fakeAuth: SettingsAuth = {
  authenticate(req: FastifyRequest): Promise<OwnerAuthContext | null> {
    return Promise.resolve(
      req.headers['x-test-owner'] ? { ownerId: OWNER, workspaceId: WS } : null,
    );
  },
  authorizeMutation(req: FastifyRequest): boolean {
    return req.headers['x-test-csrf'] === 'ok';
  },
};

function build(): { app: FastifyInstance; repo: InMemorySettingsRepository } {
  const repo = new InMemorySettingsRepository();
  repo.seedWorkspace(WS, { theme: 'dark' }, 1);
  const service = new SettingsService({
    repo,
    masterKeys: new StaticMasterKeyProvider(Buffer.alloc(32, 5)),
  });
  const app = Fastify({ logger: false });
  registerSettings(app, { service, ownerAuth: fakeAuth });
  return { app, repo };
}

const AUTH = { 'x-test-owner': '1' } as const;
const AUTH_CSRF = {
  'x-test-owner': '1',
  'x-test-csrf': 'ok',
  'content-type': 'application/json',
} as const;

let app: FastifyInstance;
beforeEach(() => {
  app = build().app;
});
afterEach(async () => {
  await app.close();
});

describe('settings routes require the injected owner auth', () => {
  it('GET /api/v1/settings without a session → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /api/v1/settings/providers without a session → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/providers',
      payload: { display_name: 'x', config: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/settings/secrets without a session → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/secrets' });
    expect(res.statusCode).toBe(401);
  });

  it('a mutation with a session but no CSRF → 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { expected_revision: 1, settings: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('workspace settings', () => {
  it('GET returns the settings + revision for the authenticated owner', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      workspace_id: WS,
      settings: { theme: 'dark' },
      revision: 1,
    });
  });

  it('PUT with the current revision succeeds; a stale revision → 409', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH_CSRF,
      payload: { expected_revision: 1, settings: { theme: 'light' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revision).toBe(2);

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH_CSRF,
      payload: { expected_revision: 1, settings: { theme: 'dark' } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('REVISION_CONFLICT');
  });

  it('rejects an invalid body → 422', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: AUTH_CSRF,
      payload: { settings: {} }, // missing expected_revision
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('provider configs (never expose secret material)', () => {
  it('POST with an inline api_key → 201 with a reference and NO plaintext', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/providers',
      headers: AUTH_CSRF,
      payload: {
        display_name: 'OpenAI',
        config: { adapter_kind: 'chat_completions', allowed_data_modes: ['redacted_cloud'] },
        api_key: 'sk-secret-http',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.credential_ref).toBeTruthy();
    expect(body.credential).not.toBeNull();
    expect(res.payload).not.toContain('sk-secret-http');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/providers',
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    expect(list.payload).not.toContain('sk-secret-http');
    expect(list.json().items).toHaveLength(1);
  });

  it('PATCH with a stale revision → 409', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/providers',
      headers: AUTH_CSRF,
      payload: { display_name: 'p', config: {} },
    });
    const id = created.json().id as string;

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/providers/${id}`,
      headers: AUTH_CSRF,
      payload: { expected_revision: 1, display_name: 'p2' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revision).toBe(2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/settings/providers/${id}`,
      headers: AUTH_CSRF,
      payload: { expected_revision: 1, display_name: 'p3' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('GET a missing provider config → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/providers/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unknown credential_ref → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/providers',
      headers: AUTH_CSRF,
      payload: {
        display_name: 'x',
        config: {},
        credential_ref: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CREDENTIAL_NOT_FOUND');
  });
});

describe('secrets metadata', () => {
  it('lists metadata only and revokes idempotently', async () => {
    // Seed a secret via a provider config with an inline key.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/providers',
      headers: AUTH_CSRF,
      payload: { display_name: 'P', config: {}, api_key: 'sk-x' },
    });
    const ref = created.json().credential_ref as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/secrets',
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    expect(list.payload).not.toContain('sk-x');
    expect(list.payload).not.toContain('ciphertext');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/secrets/${ref}`,
      headers: { 'x-test-owner': '1', 'x-test-csrf': 'ok' },
    });
    expect(del.statusCode).toBe(204);
  });
});

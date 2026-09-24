/**
 * API inject tests for the scope plugin. A bare Fastify instance mounts
 * `registerScope` with an in-memory FAKE service (the real ScopeService is proven by
 * the application unit + live-PG suites), a header-based fake owner guard and a
 * scripted DNS resolver — no database, no server.ts. These prove: owner auth (401),
 * the CSRF/mutation guard (403), body validation (422), the DNS-proof DTO never leaks
 * the challenge hash, the challenge value is returned once, the trusted resolver is
 * threaded into verify, scope-use-case errors map to the envelope, and a foreign/bad
 * id resolves to 404.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerScope,
  type GrantView,
  type DnsProofView,
  type IssueChallengeView,
  type InjectedDnsResolver,
  type OwnerContext,
  type ScopePluginService,
  type ScopeVersionView,
} from './plugin.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const now = new Date(1_700_000_000_000);

class ScopeErrorLike extends Error {
  public constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

/** A minimal in-memory fake implementing the structural plugin service. */
class FakeScopeService implements ScopePluginService {
  public proofs: DnsProofView[] = [];
  public grants: GrantView[] = [];
  public lastResolverId: string | null = null;

  private id(): string {
    return randomUUID();
  }

  async issueDnsChallenge(
    workspaceId: string,
    projectId: string,
    input: { root: string },
  ): Promise<IssueChallengeView> {
    const proof: DnsProofView = {
      id: this.id(),
      workspaceId,
      projectId,
      rootAscii: input.root.toLowerCase(),
      recordName: `_redai-challenge.${input.root.toLowerCase()}`,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 86_400_000),
      verifiedAt: null,
      observedTxtSha256: null,
      createdAt: now,
      updatedAt: now,
    };
    this.proofs.push(proof);
    return {
      proof,
      recordName: proof.recordName,
      challengeValue: 'CHALLENGE-TOKEN-VALUE',
      expiresAt: proof.expiresAt,
    };
  }

  async listDnsProofs(): Promise<DnsProofView[]> {
    return this.proofs;
  }

  async verifyDnsChallenge(
    _ws: string,
    _proj: string,
    proofId: string,
    resolver: InjectedDnsResolver,
  ): Promise<DnsProofView> {
    this.lastResolverId = resolver.id;
    const proof = this.proofs.find((p) => p.id === proofId);
    if (!proof)
      throw new ScopeErrorLike(
        'DNS_PROOF_NOT_FOUND',
        404,
        'DNS challenge not found in this project.',
      );
    const observed = await resolver.resolveTxt(proof.recordName);
    if (!observed.includes('CHALLENGE-TOKEN-VALUE'))
      throw new ScopeErrorLike(
        'DNS_PROOF_MISMATCH',
        422,
        'Challenge TXT record was not found; control not proven.',
      );
    proof.status = 'verified';
    proof.verifiedAt = now;
    proof.observedTxtSha256 = 'a'.repeat(64);
    return proof;
  }

  async authorScopeVersion(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    rawScope: unknown,
  ): Promise<ScopeVersionView> {
    const scope = rawScope as { rules?: unknown };
    if (typeof scope !== 'object' || scope === null || !Array.isArray(scope.rules))
      throw new ScopeErrorLike('INVALID_SCOPE', 422, 'Scope failed contract validation.');
    return {
      id: this.id(),
      workspaceId,
      projectId,
      version: 1,
      policy: rawScope,
      policySha256: 'b'.repeat(64),
      createdBy: ownerId,
      createdAt: now,
    };
  }

  async createGrant(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    input: {
      scopeVersionId: string;
      authorizationBasis: string;
      attestation: string;
      dnsProofId?: string;
      validUntil?: Date;
    },
  ): Promise<GrantView> {
    if (input.authorizationBasis === 'owner_attestation' && !input.dnsProofId)
      throw new ScopeErrorLike(
        'GRANT_PROOF_REQUIRED',
        422,
        'A verified DNS proof is required for these hosts.',
      );
    const grant: GrantView = {
      id: this.id(),
      workspaceId,
      projectId,
      scopeVersionId: input.scopeVersionId,
      dnsProofId: input.dnsProofId ?? null,
      createdBy: ownerId,
      authorizationBasis: input.authorizationBasis,
      attestation: input.attestation,
      status: 'active',
      policyEpoch: '1',
      validUntil: input.validUntil ?? null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.grants.push(grant);
    return grant;
  }

  async listGrants(): Promise<GrantView[]> {
    return this.grants;
  }

  async revokeGrant(_ws: string, _proj: string, grantId: string): Promise<GrantView> {
    const grant = this.grants.find((g) => g.id === grantId);
    if (!grant)
      throw new ScopeErrorLike(
        'GRANT_NOT_FOUND',
        404,
        'Authorization grant not found in this project.',
      );
    grant.status = 'revoked';
    grant.revokedAt = now;
    grant.policyEpoch = '2';
    return grant;
  }
}

interface Harness {
  app: FastifyInstance;
  svc: FakeScopeService;
}

async function setup(opts: { authorizeMutation?: boolean; txt?: string[] } = {}): Promise<Harness> {
  const svc = new FakeScopeService();
  const resolver: InjectedDnsResolver = {
    id: 'fake-resolver',
    resolveTxt: async () => opts.txt ?? ['CHALLENGE-TOKEN-VALUE'],
  };
  const app = Fastify({ logger: false });
  registerScope(app, {
    service: svc,
    authenticate: (req) => {
      const ws = req.headers['x-test-workspace'];
      return Promise.resolve(
        typeof ws === 'string' && ws !== ''
          ? ({ workspaceId: ws, ownerId: 'owner' } as OwnerContext)
          : null,
      );
    },
    authorizeMutation: () => opts.authorizeMutation ?? true,
    resolver,
  });
  await app.ready();
  return { app, svc };
}

const auth = { 'x-test-workspace': WS, 'content-type': 'application/json' };
const base = `/api/v1/projects/${PROJECT}`;

describe('scope plugin — auth', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('401 for an unauthenticated read', async () => {
    const res = await h.app.inject({ method: 'GET', url: `${base}/grants` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('401 for an unauthenticated mutation', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      payload: { root: 'example.test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when the mutation guard rejects (CSRF/Origin)', async () => {
    const g = await setup({ authorizeMutation: false });
    const res = await g.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      headers: auth,
      payload: { root: 'example.test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
  });
});

describe('scope plugin — DNS challenge', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('issues a challenge, returns the value ONCE, and never leaks the hash', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      headers: auth,
      payload: { root: 'Example.Test' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.record_name).toBe('_redai-challenge.example.test');
    expect(body.challenge_value).toBe('CHALLENGE-TOKEN-VALUE');
    expect(body.status).toBe('pending');
    // The DTO must never surface the stored hash or the internal field name.
    expect(Object.keys(body)).not.toContain('challenge_hash');
    expect(Object.keys(body)).not.toContain('challengeHash');
  });

  it('422 for a missing root', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('verifies via the injected trusted resolver', async () => {
    const issued = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      headers: auth,
      payload: { root: 'example.test' },
    });
    const proofId = issued.json().id;
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges/${proofId}/verify`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('verified');
    expect(h.svc.lastResolverId).toBe('fake-resolver');
  });

  it('maps a DNS mismatch to the DNS_PROOF_MISMATCH envelope (422)', async () => {
    const g = await setup({ txt: ['wrong'] });
    const issued = await g.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges`,
      headers: auth,
      payload: { root: 'example.test' },
    });
    const proofId = issued.json().id;
    const res = await g.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges/${proofId}/verify`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DNS_PROOF_MISMATCH');
  });

  it('404 for a non-uuid proof id', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/dns-challenges/not-a-uuid/verify`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DNS_PROOF_NOT_FOUND');
  });
});

describe('scope plugin — scope versions and grants', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it('422 when the authored scope fails contract validation', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/scope-versions`,
      headers: auth,
      payload: { policy: { schema_version: '1.0', name: 'bad' } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates a scope version for a valid scope', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/scope-versions`,
      headers: auth,
      payload: { policy: validScope() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().policy_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a public-host grant without a proof maps to GRANT_PROOF_REQUIRED (422)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${base}/grants`,
      headers: auth,
      payload: {
        scope_version_id: PROJECT,
        authorization_basis: 'owner_attestation',
        attestation: 'x',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('GRANT_PROOF_REQUIRED');
  });

  it('creates and then revokes a grant (epoch bumped)', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `${base}/grants`,
      headers: auth,
      payload: {
        scope_version_id: PROJECT,
        authorization_basis: 'lab_attestation',
        attestation: 'lab',
      },
    });
    expect(created.statusCode).toBe(201);
    const grantId = created.json().id;
    expect(created.json().policy_epoch).toBe('1');

    const revoked = await h.app.inject({
      method: 'POST',
      url: `${base}/grants/${grantId}/revoke`,
      headers: auth,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');
    expect(revoked.json().policy_epoch).toBe('2');
  });

  it('404 for a bad project id on a read', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/not-a-uuid/grants`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

function validScope(): unknown {
  return {
    schema_version: '1.0',
    name: 'valid',
    rules: [
      {
        rule_id: '10000000-0000-4000-8000-000000000020',
        host: 'app.example.test',
        match: 'exact',
        include_apex: true,
        schemes: ['https'],
        ports: [443],
        path_prefixes: ['/api/'],
        methods: ['GET'],
        zone: 'lab',
        lab_ip_ranges: ['192.0.2.0/24'],
      },
    ],
    exclusions: [],
    action_categories: ['offline', 'external_read'],
    allowed_worker_ids: [],
    allowed_zones: ['lab'],
    dependency_authorization: 'explicit_only',
    deny_platform_resources: true,
  };
}

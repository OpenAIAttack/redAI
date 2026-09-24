/**
 * T12 grant-lifecycle unit tests over the in-memory fake.
 *
 * Covers: one-time DNS challenge/verify, a second Chat reusing the grant WITHOUT
 * re-verifying, owner attestation + grant creation, scope immutability (broadening
 * authors a new version), and revoke with an epoch bump where a revoked active grant
 * retains NO permission (the live dispatch read flips to revoked).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ScopeService } from './service.js';
import { InMemoryScopeRepository, StaticDnsResolver } from './memoryRepository.js';
import {
  DnsProofMismatchError,
  GrantProofRequiredError,
  GrantProofScopeMismatchError,
  InvalidRootError,
  InvalidScopeError,
  LabAttestationMisuseError,
  PublicSuffixRootError,
} from './errors.js';
import type { Clock, RandomSource } from './ports.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = '22222222-2222-4222-8222-222222222222';

class FixedClock implements Clock {
  public constructor(private ms = 1_700_000_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class TestRandom implements RandomSource {
  private n = 0;
  uuid(): string {
    return randomUUID();
  }
  token(byteLength = 32): string {
    return randomBytes(byteLength).toString('base64url');
  }
}

function makeService(clock = new FixedClock()): {
  svc: ScopeService;
  repo: InMemoryScopeRepository;
  clock: FixedClock;
} {
  const repo = new InMemoryScopeRepository(clock);
  const svc = new ScopeService({ repo, clock, random: new TestRandom() });
  return { svc, repo, clock };
}

let ruleSeq = 0;
function ruleId(): string {
  ruleSeq += 1;
  return `30000000-0000-4000-8000-${ruleSeq.toString(16).padStart(12, '0')}`;
}

function labScope(): unknown {
  return {
    schema_version: '1.0',
    name: 'lab scope',
    rules: [
      {
        rule_id: ruleId(),
        host: 'box.lab.test',
        match: 'exact',
        include_apex: true,
        schemes: ['https'],
        ports: [443],
        path_prefixes: ['/'],
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

function publicScope(host = 'app.example.test'): unknown {
  return {
    schema_version: '1.0',
    name: 'public scope',
    rules: [
      {
        rule_id: ruleId(),
        host,
        match: 'exact',
        include_apex: true,
        schemes: ['https'],
        ports: [443],
        path_prefixes: ['/api/'],
        methods: ['GET', 'HEAD'],
        zone: 'external',
      },
    ],
    exclusions: [],
    action_categories: ['external_read'],
    allowed_worker_ids: [],
    allowed_zones: ['external'],
    dependency_authorization: 'explicit_only',
    deny_platform_resources: true,
  };
}

describe('DNS challenge issue', () => {
  it('issues a 256-bit challenge, stores only the hash, and names _redai-challenge.<root>', async () => {
    const { svc, repo } = makeService();
    const out = await svc.issueDnsChallenge(WS, PROJECT_A, { root: 'Example.Test.' });
    expect(out.recordName).toBe('_redai-challenge.example.test');
    // The raw token is not persisted; only its hash lives on the record.
    const stored = await repo.getDnsProof(WS, PROJECT_A, out.proof.id);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(out.challengeValue);
    expect(stored?.status).toBe('pending');
    // ~256 bits of entropy (32 bytes) → base64url length ≥ 43.
    expect(out.challengeValue.length).toBeGreaterThanOrEqual(43);
  });

  it('rejects an invalid root and a bare public suffix', async () => {
    const { svc } = makeService();
    await expect(
      svc.issueDnsChallenge(WS, PROJECT_A, { root: 'not a host' }),
    ).rejects.toBeInstanceOf(InvalidRootError);
    await expect(svc.issueDnsChallenge(WS, PROJECT_A, { root: 'com' })).rejects.toBeInstanceOf(
      PublicSuffixRootError,
    );
  });
});

describe('DNS challenge verify', () => {
  it('verifies when the TXT is present, and is idempotent (no re-verify)', async () => {
    const { svc } = makeService();
    const out = await svc.issueDnsChallenge(WS, PROJECT_A, { root: 'example.test' });
    const resolver = new StaticDnsResolver({ [out.recordName]: [out.challengeValue] });
    const v1 = await svc.verifyDnsChallenge(WS, PROJECT_A, out.proof.id, resolver);
    expect(v1.status).toBe('verified');
    expect(v1.verifiedAt).not.toBeNull();

    // A second verify does NOT re-run: even with an EMPTY resolver it returns verified.
    const empty = new StaticDnsResolver({});
    const v2 = await svc.verifyDnsChallenge(WS, PROJECT_A, out.proof.id, empty);
    expect(v2.status).toBe('verified');
    expect(v2.verifiedAt?.getTime()).toBe(v1.verifiedAt?.getTime());
  });

  it('fails closed when the TXT record is absent', async () => {
    const { svc } = makeService();
    const out = await svc.issueDnsChallenge(WS, PROJECT_A, { root: 'example.test' });
    const resolver = new StaticDnsResolver({ [out.recordName]: ['some-other-value'] });
    await expect(
      svc.verifyDnsChallenge(WS, PROJECT_A, out.proof.id, resolver),
    ).rejects.toBeInstanceOf(DnsProofMismatchError);
  });
});

describe('second Chat in the same Project does not re-verify', () => {
  it('reuses the active grant/proof without issuing or verifying a new challenge', async () => {
    const { svc, repo } = makeService();
    // First Chat: prove control, author scope, create grant.
    const out = await svc.issueDnsChallenge(WS, PROJECT_A, { root: 'example.test' });
    await svc.verifyDnsChallenge(
      WS,
      PROJECT_A,
      out.proof.id,
      new StaticDnsResolver({ [out.recordName]: [out.challengeValue] }),
    );
    const version = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, publicScope());
    await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: version.id,
      authorizationBasis: 'owner_attestation',
      attestation: 'I own example.test',
      dnsProofId: out.proof.id,
    });

    // Second Chat: just resolve the project authorization — no new proof.
    const auth = await svc.getProjectAuthorization(WS, PROJECT_A);
    expect(auth).not.toBeNull();
    expect(auth?.grant.status).toBe('active');
    const proofs = await repo.listDnsProofs(WS, PROJECT_A);
    expect(proofs.length).toBe(1); // still exactly one challenge
    expect(proofs[0]?.status).toBe('verified');
  });
});

describe('grant authorization basis', () => {
  it('lab_attestation authorizes explicit private-zone lab rules (no DNS proof)', async () => {
    const { svc } = makeService();
    const version = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const grant = await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: version.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'Private lab I control',
    });
    expect(grant.status).toBe('active');
    expect(grant.dnsProofId).toBeNull();
  });

  it('lab_attestation cannot authorize public hosts', async () => {
    const { svc } = makeService();
    const version = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, publicScope());
    await expect(
      svc.createGrant(WS, PROJECT_A, OWNER, {
        scopeVersionId: version.id,
        authorizationBasis: 'lab_attestation',
        attestation: 'x',
      }),
    ).rejects.toBeInstanceOf(LabAttestationMisuseError);
  });

  it('a public-host grant requires a verified DNS proof', async () => {
    const { svc } = makeService();
    const version = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, publicScope());
    await expect(
      svc.createGrant(WS, PROJECT_A, OWNER, {
        scopeVersionId: version.id,
        authorizationBasis: 'owner_attestation',
        attestation: 'x',
      }),
    ).rejects.toBeInstanceOf(GrantProofRequiredError);
  });

  it('rejects a proof whose root does not cover the authored host', async () => {
    const { svc } = makeService();
    const out = await svc.issueDnsChallenge(WS, PROJECT_A, { root: 'other.test' });
    await svc.verifyDnsChallenge(
      WS,
      PROJECT_A,
      out.proof.id,
      new StaticDnsResolver({ [out.recordName]: [out.challengeValue] }),
    );
    const version = await svc.authorScopeVersion(
      WS,
      PROJECT_A,
      OWNER,
      publicScope('app.example.test'),
    );
    await expect(
      svc.createGrant(WS, PROJECT_A, OWNER, {
        scopeVersionId: version.id,
        authorizationBasis: 'owner_attestation',
        attestation: 'x',
        dnsProofId: out.proof.id,
      }),
    ).rejects.toBeInstanceOf(GrantProofScopeMismatchError);
  });
});

describe('scope immutability and broadening', () => {
  it('authoring increments versions and never mutates an existing one', async () => {
    const { svc } = makeService();
    const v1 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const v2 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, publicScope());
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    // v1 is unchanged and there is no update path for its policy.
    const reread = await svc.getScopeVersion(WS, PROJECT_A, v1.id);
    expect(reread.policySha256).toBe(v1.policySha256);
    expect(reread.policy).toEqual(v1.policy);
  });

  it('broadening authors a NEW version + grant, leaving the prior version intact', async () => {
    const { svc } = makeService();
    const v1 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const grant1 = await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
    });
    const { scopeVersion: v2, grant: grant2 } = await svc.broadenScope(
      WS,
      PROJECT_A,
      OWNER,
      labScope(),
      { authorizationBasis: 'lab_attestation', attestation: 'lab broadened' },
    );
    expect(v2.version).toBe(2);
    expect(grant2.id).not.toBe(grant1.id);
    // The original version snapshot a Run would hold is untouched.
    const rereadV1 = await svc.getScopeVersion(WS, PROJECT_A, v1.id);
    expect(rereadV1.policySha256).toBe(v1.policySha256);
  });

  it('rejects a scope that fails contract validation', async () => {
    const { svc } = makeService();
    await expect(
      svc.authorScopeVersion(WS, PROJECT_A, OWNER, { schema_version: '1.0', name: 'bad' }),
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });
});

describe('revoke removes permission (epoch bump + live read)', () => {
  it('revoked active grant retains no permission and bumps the policy epoch', async () => {
    const { svc } = makeService();
    const v1 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const grant = await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
    });
    expect(grant.policyEpoch).toBe('1');

    // While active, the live dispatch read says active and the project has an auth.
    const before = await svc.resolveGrantStatusForDispatch(WS, PROJECT_A, grant.id);
    expect(before.effectiveStatus).toBe('active');
    expect(await svc.getProjectAuthorization(WS, PROJECT_A)).not.toBeNull();

    const revoked = await svc.revokeGrant(WS, PROJECT_A, grant.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.policyEpoch).toBe('2'); // epoch bumped

    // Dispatch re-reads the LIVE grant: it is revoked, so no permission remains.
    const after = await svc.resolveGrantStatusForDispatch(WS, PROJECT_A, grant.id);
    expect(after.effectiveStatus).toBe('revoked');
    expect(await svc.getProjectAuthorization(WS, PROJECT_A)).toBeNull();

    // Idempotent second revoke.
    const again = await svc.revokeGrant(WS, PROJECT_A, grant.id);
    expect(again.status).toBe('revoked');
  });

  it('a grant past valid_until reads as expired at dispatch time', async () => {
    const { svc, clock } = makeService();
    const v1 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const grant = await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
      validUntil: new Date(clock.now().getTime() + 1000),
    });
    expect((await svc.resolveGrantStatusForDispatch(WS, PROJECT_A, grant.id)).effectiveStatus).toBe(
      'active',
    );
    clock.advance(5000);
    expect((await svc.resolveGrantStatusForDispatch(WS, PROJECT_A, grant.id)).effectiveStatus).toBe(
      'expired',
    );
    expect(await svc.getProjectAuthorization(WS, PROJECT_A)).toBeNull();
  });
});

describe('cross-project isolation (INV-001)', () => {
  it('a grant in project A is invisible to project B', async () => {
    const { svc } = makeService();
    const v1 = await svc.authorScopeVersion(WS, PROJECT_A, OWNER, labScope());
    const grant = await svc.createGrant(WS, PROJECT_A, OWNER, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
    });
    expect(await svc.getProjectAuthorization(WS, PROJECT_B)).toBeNull();
    await expect(svc.getGrant(WS, PROJECT_B, grant.id)).rejects.toThrow();
  });
});

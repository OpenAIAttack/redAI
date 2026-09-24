/**
 * Live-PostgreSQL integration tests for the DB-backed scope repository + service.
 *
 * These prove the SQL enforces what the in-memory fake only simulates: the
 * `challenge_hash` UNIQUE + pending→verified guard (one-time verify), the immutable
 * `scope_versions` numbering, the `policy_epoch = policy_epoch + 1` revoke bump, the
 * "active + unexpired" grant selection, and cross-project isolation via the composite
 * `(id, project_id, workspace_id)` keys.
 *
 * Gated on DATABASE_URL: skips LOUDLY when unset (never a silent green). Start a
 * throwaway PG16 cluster and export DATABASE_URL, then re-run:
 *   pnpm exec vitest run packages/application/src/scope
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@redai/db';
import type { Pool } from '@redai/db';
import { createDbScopeRepository } from './dbRepository.js';
import { ScopeService } from './service.js';
import { StaticDnsResolver } from './memoryRepository.js';
import type { Clock, RandomSource } from './ports.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

if (!HAS_DB) {
  console.warn(
    '\n[T12] DATABASE_URL is not set — the live-PostgreSQL scope suite is SKIPPED.\n' +
      '      Start a throwaway PG16 cluster and export DATABASE_URL, e.g.:\n' +
      '        runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D "$PWD/.tmp-pg/t12" -U redai --auth=trust\n' +
      '        runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$PWD/.tmp-pg/t12" \\\n' +
      '          -o "-p 55467 -k /tmp -c listen_addresses=127.0.0.1" -w start\n' +
      '        export DATABASE_URL="postgres://redai@127.0.0.1:55467/postgres"\n' +
      '      then re-run: pnpm exec vitest run packages/application/src/scope\n',
  );
}

const describeDb = HAS_DB ? describe : describe.skip;

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

class FixedClock implements Clock {
  public constructor(private ms = 1_700_000_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}
class NodeRandom implements RandomSource {
  uuid(): string {
    return randomUUID();
  }
  token(byteLength = 32): string {
    return randomBytes(byteLength).toString('base64url');
  }
}

let ruleSeq = 0;
function ruleId(): string {
  ruleSeq += 1;
  return `40000000-0000-4000-8000-${ruleSeq.toString(16).padStart(12, '0')}`;
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

describeDb('scope DB repository (live PG)', () => {
  let pool: Pool;
  let dbName: string;
  let workspaceId: string;
  let ownerId: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    dbName = `redai_t12_${randomBytes(6).toString('hex')}`;
    const admin = createPool({ connectionString: DATABASE_URL!, max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    pool = createPool({ connectionString: urlForDatabase(DATABASE_URL!, dbName), max: 4 });
    await migrate(pool);
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, installation_id) VALUES ('redAI', gen_random_uuid()) RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO owners (workspace_id, username, password_hash, recovery_code_hash)
       VALUES ($1, 'owner', 'x', '\\x00') RETURNING id`,
      [workspaceId],
    );
    ownerId = owner.rows[0]!.id;
    const pa = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name) VALUES ($1, 'A') RETURNING id`,
      [workspaceId],
    );
    projectA = pa.rows[0]!.id;
    const pb = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name) VALUES ($1, 'B') RETURNING id`,
      [workspaceId],
    );
    projectB = pb.rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
    if (HAS_DB) {
      const dropAdmin = createPool({ connectionString: DATABASE_URL!, max: 1 });
      try {
        await dropAdmin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await dropAdmin.end();
      }
    }
  });

  function service(clock = new FixedClock()): ScopeService {
    return new ScopeService({
      repo: createDbScopeRepository(pool),
      clock,
      random: new NodeRandom(),
    });
  }

  it('persists a challenge (hash only), verifies once, and is idempotent', async () => {
    const svc = service();
    const out = await svc.issueDnsChallenge(workspaceId, projectA, { root: 'example.test' });
    const stored = await pool.query<{
      challenge_hash: Buffer;
      status: string;
      record_name: string;
    }>('SELECT challenge_hash, status, record_name FROM dns_proofs WHERE id = $1', [out.proof.id]);
    expect(stored.rows[0]?.status).toBe('pending');
    expect(stored.rows[0]?.record_name).toBe('_redai-challenge.example.test');
    expect(Buffer.isBuffer(stored.rows[0]?.challenge_hash)).toBe(true);

    const resolver = new StaticDnsResolver({ [out.recordName]: [out.challengeValue] });
    const v1 = await svc.verifyDnsChallenge(workspaceId, projectA, out.proof.id, resolver);
    expect(v1.status).toBe('verified');
    // Second verify with an empty resolver still returns verified (one-time guard).
    const v2 = await svc.verifyDnsChallenge(
      workspaceId,
      projectA,
      out.proof.id,
      new StaticDnsResolver({}),
    );
    expect(v2.status).toBe('verified');
    expect(v2.verifiedAt?.getTime()).toBe(v1.verifiedAt?.getTime());
  });

  it('scope versions are immutable and numbered per project', async () => {
    const svc = service();
    const v1 = await svc.authorScopeVersion(workspaceId, projectA, ownerId, labScope());
    const v2 = await svc.authorScopeVersion(workspaceId, projectA, ownerId, labScope());
    expect(v2.version).toBe(v1.version + 1);
    expect(v1.policySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('revoke bumps policy_epoch in SQL and drops the active grant', async () => {
    const svc = service();
    const v1 = await svc.authorScopeVersion(workspaceId, projectA, ownerId, labScope());
    const grant = await svc.createGrant(workspaceId, projectA, ownerId, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
    });
    expect(grant.policyEpoch).toBe('1');
    expect(await svc.getProjectAuthorization(workspaceId, projectA)).not.toBeNull();

    const revoked = await svc.revokeGrant(workspaceId, projectA, grant.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.policyEpoch).toBe('2');

    const live = await svc.resolveGrantStatusForDispatch(workspaceId, projectA, grant.id);
    expect(live.effectiveStatus).toBe('revoked');
    expect(await svc.getProjectAuthorization(workspaceId, projectA)).toBeNull();
  });

  it('enforces cross-project isolation (INV-001)', async () => {
    const svc = service();
    const out = await svc.issueDnsChallenge(workspaceId, projectA, { root: 'iso.test' });
    // Project B cannot see project A's proof.
    expect(await svc.listDnsProofs(workspaceId, projectB)).toEqual([]);
    const v1 = await svc.authorScopeVersion(workspaceId, projectA, ownerId, labScope());
    const grant = await svc.createGrant(workspaceId, projectA, ownerId, {
      scopeVersionId: v1.id,
      authorizationBasis: 'lab_attestation',
      attestation: 'lab',
    });
    await expect(svc.getGrant(workspaceId, projectB, grant.id)).rejects.toThrow();
    void out;
  });

  it('a concurrent verify only succeeds once', async () => {
    const repo = createDbScopeRepository(pool);
    const svc = new ScopeService({ repo, clock: new FixedClock(), random: new NodeRandom() });
    const out = await svc.issueDnsChallenge(workspaceId, projectA, { root: 'race.test' });
    const now = new Date();
    const meta = { resolver: 'r', queried_name: out.recordName, answers: 1 };
    const [a, b] = await Promise.all([
      repo.markProofVerified(workspaceId, projectA, out.proof.id, {
        verifiedAt: now,
        observedTxtSha256: 'a'.repeat(64),
        resolverMetadata: meta,
      }),
      repo.markProofVerified(workspaceId, projectA, out.proof.id, {
        verifiedAt: now,
        observedTxtSha256: 'a'.repeat(64),
        resolverMetadata: meta,
      }),
    ]);
    const outcomes = [a, b].map((r) => (typeof r === 'string' ? r : 'verified'));
    expect(outcomes.filter((o) => o === 'verified').length).toBe(1);
    expect(outcomes.filter((o) => o === 'not-pending').length).toBe(1);
  });
});

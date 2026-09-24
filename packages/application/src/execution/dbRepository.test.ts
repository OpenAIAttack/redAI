/**
 * Live-PostgreSQL integration test for the DB-backed scheduler repository (T17, D09).
 *
 * Gated on DATABASE_URL: when it is unset the suite SKIPS loudly (never a silent
 * green). It creates a throwaway database, runs the real migrations and drives the
 * REAL {@link ExecutionService} over the SQL adapter to prove the guarantees that only
 * a real database can show:
 *   - two concurrent claims on two connections give one queued attempt to exactly one
 *     worker (`FOR UPDATE SKIP LOCKED`), and capacity is never oversubscribed;
 *   - ACK/result dedup, a conflicting digest quarantine, and a stale fence refusal;
 *   - renewal refuses on a superseded session, a bumped policy epoch and lease expiry.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@redai/db';
import type { Pool } from '@redai/db';
import {
  ExecutionService,
  ResultConflictError,
  StaleFenceError,
  canonicalSha256Hex,
  createDbExecutionRepository,
  createEd25519LeaseSigner,
  ed25519PublicKeyFromBase64Url,
  verifyLeaseJws,
  type Clock,
} from './index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

if (!HAS_DB) {
  console.warn(
    '\n[T17] DATABASE_URL is not set — the scheduler DB suite is SKIPPED.\n' +
      '      Start a throwaway PostgreSQL cluster and export DATABASE_URL, then re-run:\n' +
      '        pnpm exec vitest run packages/application/src/execution/dbRepository.test.ts\n',
  );
}

const describeDb = HAS_DB ? describe : describe.skip;

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

class MutableClock implements Clock {
  public current = new Date('2026-09-24T00:00:00.000Z');
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const IMAGE = 'sha256:' + 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const INPUT = { echo: 'hello' };

interface Fixture {
  workspaceId: string;
  projectId: string;
  runId: string;
  toolCallId: string;
  workerId: string;
  sessionId: string;
  grantId: string;
}

describeDb('scheduler DB repository (live PG)', () => {
  let pool: Pool;
  let dbName: string;
  // The workspace is a singleton (one row per database), so it is created ONCE and all
  // tests share it, seeding distinct projects/runs/workers/tool_calls per case.
  let workspaceId: string;
  let ownerId: string;
  const trusted = new Map<string, ReturnType<typeof ed25519PublicKeyFromBase64Url>>();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signer = createEd25519LeaseSigner(privateKey, 'k1');

  beforeAll(async () => {
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    trusted.set('k1', ed25519PublicKeyFromBase64Url(jwk.x));
    dbName = `redai_t17_${randomBytes(6).toString('hex')}`;
    const admin = createPool({ connectionString: DATABASE_URL!, max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    pool = createPool({ connectionString: urlForDatabase(DATABASE_URL!, dbName), max: 8 });
    await migrate(pool);
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, installation_id) VALUES ('redAI', gen_random_uuid()) RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO owners (workspace_id, username, password_hash, recovery_code_hash)
       VALUES ($1, 'owner', 'x', $2) RETURNING id`,
      [workspaceId, randomBytes(16)],
    );
    ownerId = owner.rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
    if (HAS_DB && dbName) {
      const admin = createPool({ connectionString: DATABASE_URL!, max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  /** Seed a fresh workspace/project/run/worker/tool_call and return their ids. */
  async function seed(opts: { scoped?: boolean; capacity?: number } = {}): Promise<Fixture> {
    const sessionId = randomUUID();
    const zone = `z_${randomBytes(3).toString('hex')}`;
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name) VALUES ($1, 'p') RETURNING id`,
      [workspaceId],
    );
    const projectId = proj.rows[0]!.id;
    const pc = await pool.query<{ id: string }>(
      `INSERT INTO provider_configs (workspace_id, display_name, config) VALUES ($1, 'mock', '{}'::jsonb) RETURNING id`,
      [workspaceId],
    );
    const providerConfigId = pc.rows[0]!.id;
    const chat = await pool.query<{ id: string }>(
      `INSERT INTO chats (workspace_id, project_id) VALUES ($1, $2) RETURNING id`,
      [workspaceId, projectId],
    );
    const chatId = chat.rows[0]!.id;

    let scopeVersionId: string | null = null;
    let grantId = '';
    if (opts.scoped) {
      const sv = await pool.query<{ id: string }>(
        `INSERT INTO scope_versions (workspace_id, project_id, version, policy, policy_sha256, created_by)
         VALUES ($1, $2, 1, '{"version":1,"rules":[]}'::jsonb, $3, $4) RETURNING id`,
        [workspaceId, projectId, 'c'.repeat(64), ownerId],
      );
      scopeVersionId = sv.rows[0]!.id;
      const g = await pool.query<{ id: string }>(
        `INSERT INTO authorization_grants
           (workspace_id, project_id, scope_version_id, created_by, authorization_basis, attestation)
         VALUES ($1, $2, $3, $4, 'owner_attestation', 'ok') RETURNING id`,
        [workspaceId, projectId, scopeVersionId, ownerId],
      );
      grantId = g.rows[0]!.id;
    }

    const run = await pool.query<{ id: string }>(
      `INSERT INTO runs
         (workspace_id, project_id, chat_id, mode, state, provider_config_id, scope_version_id, grant_id,
          config_snapshot, budget_limit_micro_usd, expires_at)
       VALUES ($1, $2, $3, 'agent', 'running', $4, $5, $6, '{}'::jsonb, 1000000, now() + interval '1 day')
       RETURNING id`,
      [
        workspaceId,
        projectId,
        chatId,
        providerConfigId,
        scopeVersionId,
        opts.scoped ? grantId : null,
      ],
    );
    const runId = run.rows[0]!.id;

    const worker = await pool.query<{ id: string }>(
      `INSERT INTO workers (workspace_id, display_name, zone, capacity, state, agent_version, manifest_sha256, session_id, session_generation)
       VALUES ($1, 'w', $2, $3, 'online', '1.0.0', $4, $5, 1) RETURNING id`,
      [workspaceId, zone, opts.capacity ?? 2, MANIFEST, sessionId],
    );
    const workerId = worker.rows[0]!.id;
    await pool.query(
      `INSERT INTO project_workers (workspace_id, project_id, worker_id, zone) VALUES ($1, $2, $3, $4)`,
      [workspaceId, projectId, workerId, zone],
    );

    const tc = await pool.query<{ id: string }>(
      `INSERT INTO tool_calls
         (workspace_id, project_id, run_id, actor_kind, tool_name, tool_version, canonical_input, input_sha256,
          effect_class, state, policy_decision, fingerprint)
       VALUES ($1, $2, $3, 'owner', $4, '1', $5, $6, $7, 'queued', '{}'::jsonb, 'fp')
       RETURNING id`,
      [
        workspaceId,
        projectId,
        runId,
        opts.scoped ? 'http_request' : 'fs_read',
        JSON.stringify(INPUT),
        canonicalSha256Hex(INPUT),
        opts.scoped ? 'external_read' : 'sandbox_write',
      ],
    );
    return {
      workspaceId,
      projectId,
      runId,
      toolCallId: tc.rows[0]!.id,
      workerId,
      sessionId,
      grantId,
    };
  }

  function makeService(clock?: Clock): ExecutionService {
    return new ExecutionService({
      repo: createDbExecutionRepository(pool),
      signer,
      ...(clock ? { clock } : {}),
      config: { imageDigest: IMAGE, toolManifestSha256: MANIFEST },
    });
  }

  it('claims, mints a verifiable lease, and dedups the result', async () => {
    const f = await seed();
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    const attempt = await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const env = await svc.claim(scope, f.sessionId);
    expect(env).not.toBeNull();
    const claims = verifyLeaseJws(env!.lease_jws, trusted);
    expect(claims['attempt_id']).toBe(attempt.id);
    expect(claims['input_sha256']).toBe(canonicalSha256Hex(INPUT));

    const fence = env!.claims['fencing_token'] as string;
    await svc.ack(scope, attempt.id, {
      sessionId: f.sessionId,
      fencingToken: fence,
      phase: 'started',
      journalSeq: '1',
      containerRef: 'c1',
    });
    const result = {
      sessionId: f.sessionId,
      fencingToken: fence,
      status: 'succeeded' as const,
      startedAt: new Date('2026-09-24T00:00:01.000Z'),
      finishedAt: new Date('2026-09-24T00:00:02.000Z'),
      exitCode: 0,
      summary: 'ok',
      artifactIds: [],
      structuredResult: {},
      outputTruncated: false,
      observedQuiescent: true,
      effectObservation: 'completed' as const,
      resultSha256: 'd'.repeat(64),
      resultJson: { status: 'succeeded' },
    };
    const first = await svc.submitResult(scope, attempt.id, result);
    const dup = await svc.submitResult(scope, attempt.id, result);
    expect(first).toEqual({ accepted: true, duplicate: false, authoritative: true });
    expect(dup).toEqual({ accepted: true, duplicate: true, authoritative: true });

    await expect(
      svc.submitResult(scope, attempt.id, { ...result, resultSha256: 'e'.repeat(64) }),
    ).rejects.toBeInstanceOf(ResultConflictError);
  });

  it('gives one attempt to exactly one of two concurrent claimers', async () => {
    const f = await seed({ capacity: 2 });
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const [a, b] = await Promise.all([
      svc.claim(scope, f.sessionId),
      svc.claim(scope, f.sessionId),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it('never leases beyond worker_capacity', async () => {
    const f = await seed({ capacity: 1 });
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    // A second tool call so there are two queued attempts competing for one slot.
    const tc2 = await pool.query<{ id: string }>(
      `INSERT INTO tool_calls (workspace_id, project_id, run_id, actor_kind, tool_name, tool_version, canonical_input, input_sha256, effect_class, state, policy_decision, fingerprint)
       VALUES ($1, $2, $3, 'owner', 'fs_read', '1', $4, $5, 'sandbox_write', 'queued', '{}'::jsonb, 'fp2') RETURNING id`,
      [f.workspaceId, f.projectId, f.runId, JSON.stringify(INPUT), canonicalSha256Hex(INPUT)],
    );
    await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: tc2.rows[0]!.id,
    });
    const e1 = await svc.claim(scope, f.sessionId);
    const e2 = await svc.claim(scope, f.sessionId);
    expect(e1).not.toBeNull();
    expect(e2).toBeNull();
  });

  it('refuses renewal when the worker session is superseded', async () => {
    const f = await seed();
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    const a = await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const env = await svc.claim(scope, f.sessionId);
    const fence = env!.claims['fencing_token'] as string;
    await pool.query(
      `UPDATE workers SET session_id = gen_random_uuid(), session_generation = session_generation + 1 WHERE id = $1`,
      [f.workerId],
    );
    const r = await svc.renew(scope, a.id, {
      sessionId: f.sessionId,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('session_superseded');
  });

  it('refuses renewal when the grant policy epoch was bumped', async () => {
    const f = await seed({ scoped: true });
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    const a = await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const env = await svc.claim(scope, f.sessionId);
    expect(env!.claims['network_profile']).toBe('scoped_web');
    const fence = env!.claims['fencing_token'] as string;
    await pool.query(
      `UPDATE authorization_grants SET policy_epoch = policy_epoch + 1 WHERE id = $1`,
      [f.grantId],
    );
    const r = await svc.renew(scope, a.id, {
      sessionId: f.sessionId,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('policy_epoch_stale');
  });

  it('refuses renewal once the lease has expired', async () => {
    const f = await seed();
    const clock = new MutableClock();
    const svc = makeService(clock);
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    const a = await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const env = await svc.claim(scope, f.sessionId);
    const fence = env!.claims['fencing_token'] as string;
    clock.advance(46_000);
    const r = await svc.renew(scope, a.id, {
      sessionId: f.sessionId,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('lease_expired');
  });

  it("rejects a stale attempt's result after an explicit reconcile re-attempt", async () => {
    const f = await seed();
    const svc = makeService();
    const scope = { workspaceId: f.workspaceId, workerId: f.workerId };
    const a1 = await svc.enqueueAttempt({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      runId: f.runId,
      toolCallId: f.toolCallId,
    });
    const env = await svc.claim(scope, f.sessionId);
    const fence1 = env!.claims['fencing_token'] as string;
    const repo = createDbExecutionRepository(pool);
    const a2 = await repo.reattemptAfterReconcile(
      f.workspaceId,
      a1.id,
      randomUUID(),
      'unproven_outcome',
    );
    expect(a2.attemptNo).toBe(2);
    await expect(
      svc.submitResult(scope, a1.id, {
        sessionId: f.sessionId,
        fencingToken: fence1,
        status: 'succeeded',
        startedAt: null,
        finishedAt: new Date(),
        exitCode: 0,
        summary: '',
        artifactIds: [],
        structuredResult: {},
        outputTruncated: false,
        observedQuiescent: true,
        effectObservation: 'unknown',
        resultSha256: 'a'.repeat(64),
        resultJson: {},
      }),
    ).rejects.toBeInstanceOf(StaleFenceError);
  });
});

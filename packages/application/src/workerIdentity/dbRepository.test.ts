/**
 * Live-PostgreSQL integration test for the DB-backed worker-identity repository.
 *
 * Gated on DATABASE_URL: when it is unset the suite SKIPS loudly (never a silent
 * green). It creates its own throwaway database on the cluster named by DATABASE_URL,
 * runs the real migrations, and exercises the atomic redeem/verify/rotate/revoke
 * paths against actual SQL — including the single-use guard under a `FOR UPDATE` lock.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@redai/db';
import type { Pool } from '@redai/db';
import { hashToken } from '../auth/crypto.js';
import { createDbWorkerIdentityRepository } from './dbRepository.js';
import { WorkerIdentityService } from './service.js';
import {
  EnrollmentAlreadyConsumedError,
  EnrollmentExpiredError,
  WorkerCredentialInvalidError,
} from './errors.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

if (!HAS_DB) {
  console.warn(
    '\n[T15] DATABASE_URL is not set — the worker-identity DB suite is SKIPPED.\n' +
      '      Start a throwaway PostgreSQL cluster and export DATABASE_URL, then re-run:\n' +
      '        pnpm exec vitest run packages/application/src/workerIdentity\n',
  );
}

const describeDb = HAS_DB ? describe : describe.skip;

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeDb('worker-identity DB repository (live PG)', () => {
  let pool: Pool;
  let dbName: string;
  let workspaceId: string;

  beforeAll(async () => {
    dbName = `redai_t15_${randomBytes(6).toString('hex')}`;
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

  function service(nowMs?: number): WorkerIdentityService {
    const repo = createDbWorkerIdentityRepository(pool);
    const clock = { now: () => new Date(nowMs ?? Date.now()) };
    return new WorkerIdentityService({ repo, clock });
  }

  const baseRedeem = {
    displayName: 'lab-worker',
    arch: 'amd64',
    agentVersion: '1.0.0',
    manifestSha256: 'b'.repeat(64),
    capacity: 2,
  };

  it('redeems an enrollment token once, storing only a credential hash', async () => {
    const svc = service();
    const token = await svc.createEnrollmentToken({ workspaceId, zone: 'lab-a' });
    const workerId = randomUUID();
    const redeemed = await svc.redeemEnrollment({
      ...baseRedeem,
      workerId,
      enrollmentToken: token.enrollmentToken,
    });

    expect(redeemed.workerId).toBe(workerId);
    expect(redeemed.workspaceId).toBe(workspaceId);

    // Only the hash is on disk.
    const row = await pool.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM worker_credentials WHERE id = $1`,
      [redeemed.credentialId],
    );
    expect(row.rows[0]!.token_hash.equals(hashToken(redeemed.workerCredential))).toBe(true);

    // The enrollment token is marked consumed by this worker.
    const tokRow = await pool.query<{ consumed_worker_id: string | null }>(
      `SELECT consumed_worker_id FROM enrollment_tokens WHERE id = $1`,
      [token.enrollmentTokenId],
    );
    expect(tokRow.rows[0]!.consumed_worker_id).toBe(workerId);

    const ctx = await svc.verifyCredential(redeemed.workerCredential);
    expect(ctx.workerId).toBe(workerId);
    expect(ctx.zone).toBe('lab-a');
  });

  it('rejects a second redemption of the same token', async () => {
    const svc = service();
    const token = await svc.createEnrollmentToken({ workspaceId, zone: 'lab-a' });
    await svc.redeemEnrollment({
      ...baseRedeem,
      workerId: randomUUID(),
      enrollmentToken: token.enrollmentToken,
    });
    await expect(
      svc.redeemEnrollment({
        ...baseRedeem,
        workerId: randomUUID(),
        enrollmentToken: token.enrollmentToken,
      }),
    ).rejects.toBeInstanceOf(EnrollmentAlreadyConsumedError);
  });

  it('rejects redemption after the TTL', async () => {
    const past = Date.now() - 3_600_000; // token minted an hour ago
    const stale = service(past);
    const token = await stale.createEnrollmentToken({ workspaceId, zone: 'lab-a' });
    const now = service(); // "now" is an hour later, well past the 10-min TTL
    await expect(
      now.redeemEnrollment({
        ...baseRedeem,
        workerId: randomUUID(),
        enrollmentToken: token.enrollmentToken,
      }),
    ).rejects.toBeInstanceOf(EnrollmentExpiredError);
  });

  it('rotates with overlap and revokes immediately', async () => {
    const svc = service();
    const token = await svc.createEnrollmentToken({ workspaceId, zone: 'lab-a' });
    const workerId = randomUUID();
    const redeemed = await svc.redeemEnrollment({
      ...baseRedeem,
      workerId,
      enrollmentToken: token.enrollmentToken,
    });

    const ctx = await svc.verifyCredential(redeemed.workerCredential);
    const rotated = await svc.rotateCredential(ctx);
    // Both valid during the overlap window.
    await expect(svc.verifyCredential(rotated.workerCredential)).resolves.toMatchObject({
      workerId,
    });
    await expect(svc.verifyCredential(redeemed.workerCredential)).resolves.toMatchObject({
      workerId,
    });

    // Revoke the whole worker: every credential dies at once.
    await svc.revokeWorker(workerId);
    await expect(svc.verifyCredential(rotated.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
    await expect(svc.verifyCredential(redeemed.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
  });

  it('serialises two concurrent redemptions to exactly one worker', async () => {
    const svc = service();
    const token = await svc.createEnrollmentToken({ workspaceId, zone: 'lab-a' });
    const results = await Promise.allSettled([
      svc.redeemEnrollment({
        ...baseRedeem,
        workerId: randomUUID(),
        enrollmentToken: token.enrollmentToken,
      }),
      svc.redeemEnrollment({
        ...baseRedeem,
        workerId: randomUUID(),
        enrollmentToken: token.enrollmentToken,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

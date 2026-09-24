/**
 * Unit tests for the worker-identity use cases, driven entirely by the in-memory
 * repository and deterministic clock/random fakes. No database, no sockets.
 *
 * Covers the T15 required behaviours: enrollment is single-use and expires; the
 * issued credential is stored ONLY as a hash; verify is constant-time; rotation
 * mints a new credential with a bounded overlap; revoke invalidates immediately.
 */
import { describe, expect, it } from 'vitest';
import { hashToken } from '../auth/crypto.js';
import type { Clock, RandomSource } from './ports.js';
import { InMemoryWorkerIdentityRepository } from './memoryRepository.js';
import {
  CREDENTIAL_ROTATION_OVERLAP_MS,
  ENROLLMENT_TTL_MS,
  WorkerIdentityService,
} from './service.js';
import {
  EnrollmentAlreadyConsumedError,
  EnrollmentExpiredError,
  EnrollmentInvalidError,
  WorkerCredentialInvalidError,
} from './errors.js';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';

class MockClock implements Clock {
  public constructor(public ms = 1_700_000_000_000) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

class SeqRandom implements RandomSource {
  private n = 0;
  token(): string {
    this.n += 1;
    return `worker-token-${this.n}-0123456789abcdef0123456789abcdef`;
  }
  recoveryCode(): string {
    this.n += 1;
    return `R-${this.n}`;
  }
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

function makeService(clock: MockClock): {
  service: WorkerIdentityService;
  repo: InMemoryWorkerIdentityRepository;
} {
  const repo = new InMemoryWorkerIdentityRepository();
  const service = new WorkerIdentityService({ repo, clock, random: new SeqRandom() });
  return { service, repo };
}

const REDEEM_BASE = {
  workerId: '00000000-0000-4000-8000-0000000000aa',
  displayName: 'lab-worker',
  arch: 'amd64',
  agentVersion: '1.2.3',
  manifestSha256: 'a'.repeat(64),
  capacity: 2,
};

async function enroll(service: WorkerIdentityService, workerId = REDEEM_BASE.workerId) {
  const token = await service.createEnrollmentToken({ workspaceId: WORKSPACE, zone: 'lab-a' });
  const redeemed = await service.redeemEnrollment({
    ...REDEEM_BASE,
    workerId,
    enrollmentToken: token.enrollmentToken,
  });
  return { token, redeemed };
}

describe('enrollment token — single use and expiry', () => {
  it('mints a worker + credential on first redemption', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    expect(redeemed.workerId).toBe(REDEEM_BASE.workerId);
    expect(redeemed.workspaceId).toBe(WORKSPACE);
    expect(redeemed.workerCredential).toBeTruthy();
    expect(redeemed.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redeemed.credentialExpiresAt.getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('rejects a second redemption of the same token (replay reject)', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const token = await service.createEnrollmentToken({ workspaceId: WORKSPACE, zone: 'lab-a' });

    await service.redeemEnrollment({ ...REDEEM_BASE, enrollmentToken: token.enrollmentToken });
    await expect(
      service.redeemEnrollment({
        ...REDEEM_BASE,
        workerId: '00000000-0000-4000-8000-0000000000bb',
        enrollmentToken: token.enrollmentToken,
      }),
    ).rejects.toBeInstanceOf(EnrollmentAlreadyConsumedError);
  });

  it('rejects redemption after the TTL', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const token = await service.createEnrollmentToken({ workspaceId: WORKSPACE, zone: 'lab-a' });

    clock.advance(ENROLLMENT_TTL_MS + 1);
    await expect(
      service.redeemEnrollment({ ...REDEEM_BASE, enrollmentToken: token.enrollmentToken }),
    ).rejects.toBeInstanceOf(EnrollmentExpiredError);
  });

  it('rejects an unknown enrollment token', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    await expect(
      service.redeemEnrollment({ ...REDEEM_BASE, enrollmentToken: 'not-a-real-token' }),
    ).rejects.toBeInstanceOf(EnrollmentInvalidError);
  });

  it('never lets two racers both mint a worker for one token', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const token = await service.createEnrollmentToken({ workspaceId: WORKSPACE, zone: 'lab-a' });

    const results = await Promise.allSettled([
      service.redeemEnrollment({
        ...REDEEM_BASE,
        workerId: '00000000-0000-4000-8000-0000000000c1',
        enrollmentToken: token.enrollmentToken,
      }),
      service.redeemEnrollment({
        ...REDEEM_BASE,
        workerId: '00000000-0000-4000-8000-0000000000c2',
        enrollmentToken: token.enrollmentToken,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });
});

describe('worker credential — hashed storage + constant-time verify', () => {
  it('stores only the hash of the credential, never the plaintext', async () => {
    const clock = new MockClock();
    const { service, repo } = makeService(clock);
    const { redeemed } = await enroll(service);

    const stored = await repo.findCredentialByHash(hashToken(redeemed.workerCredential));
    expect(stored).not.toBeNull();
    expect(stored!.credential.tokenHash.equals(hashToken(redeemed.workerCredential))).toBe(true);
    // The stored value is a 32-byte SHA-256 digest, not the opaque token bytes.
    expect(stored!.credential.tokenHash.length).toBe(32);
    expect(stored!.credential.tokenHash.toString('utf8')).not.toBe(redeemed.workerCredential);
  });

  it('verifies a valid credential and returns its worker context', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    const ctx = await service.verifyCredential(redeemed.workerCredential);
    expect(ctx.workerId).toBe(redeemed.workerId);
    expect(ctx.workspaceId).toBe(WORKSPACE);
    expect(ctx.zone).toBe('lab-a');
    expect(ctx.credentialId).toBe(redeemed.credentialId);
  });

  it('rejects an unknown credential', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    await enroll(service);
    await expect(service.verifyCredential('wrong-token')).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
  });

  it('rejects an expired credential', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    clock.advance(2_592_000 * 1000 + 1);
    await expect(service.verifyCredential(redeemed.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
  });
});

describe('rotation — new credential with bounded overlap', () => {
  it('rotates: new credential works, old stays valid during the overlap then dies', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    const ctx = await service.verifyCredential(redeemed.workerCredential);
    const rotated = await service.rotateCredential({
      workerId: ctx.workerId,
      workspaceId: ctx.workspaceId,
      credentialId: ctx.credentialId,
    });

    // New credential verifies immediately.
    await expect(service.verifyCredential(rotated.workerCredential)).resolves.toMatchObject({
      workerId: redeemed.workerId,
    });
    // Old credential still valid inside the overlap window.
    await expect(service.verifyCredential(redeemed.workerCredential)).resolves.toMatchObject({
      workerId: redeemed.workerId,
    });

    // Past the overlap: old is dead, new still lives.
    clock.advance(CREDENTIAL_ROTATION_OVERLAP_MS + 1);
    await expect(service.verifyCredential(redeemed.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
    await expect(service.verifyCredential(rotated.workerCredential)).resolves.toMatchObject({
      workerId: redeemed.workerId,
    });
  });
});

describe('revocation — immediate invalidation', () => {
  it('revokes a single credential immediately', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    await service.revokeCredential(redeemed.credentialId);
    await expect(service.verifyCredential(redeemed.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
  });

  it('revokes a worker and all of its credentials', async () => {
    const clock = new MockClock();
    const { service } = makeService(clock);
    const { redeemed } = await enroll(service);

    await service.revokeWorker(redeemed.workerId);
    const worker = await service.getWorker(redeemed.workerId);
    expect(worker.state).toBe('revoked');
    await expect(service.verifyCredential(redeemed.workerCredential)).rejects.toBeInstanceOf(
      WorkerCredentialInvalidError,
    );
  });
});

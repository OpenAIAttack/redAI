import { describe, expect, it } from 'vitest';
import { AuthService } from './service.js';
import { InMemoryAuthRepository } from './memoryRepository.js';
import {
  InvalidCredentialsError,
  OwnerExistsError,
  RecoveryInvalidError,
  SessionInvalidError,
  WeakPasswordError,
} from './errors.js';
import type { Clock, PasswordHasher, RandomSource, SessionPolicy } from './ports.js';

/** Fast, deterministic collaborators so the KDF and randomness never slow the tests. */
class MockClock implements Clock {
  public constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

const fakeHasher: PasswordHasher = {
  hash: (plain) => Promise.resolve(`fake$${plain}`),
  verify: (plain, stored) => Promise.resolve(stored === `fake$${plain}`),
};

class SeqRandom implements RandomSource {
  private n = 0;
  token(byteLength = 32): string {
    this.n += 1;
    return `tok-${this.n}-${'a'.repeat(byteLength)}`;
  }
  recoveryCode(): string {
    this.n += 1;
    return `RECOVERY-CODE-${this.n}`;
  }
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

function makeService(
  overrides: {
    clock?: Clock;
    policy?: SessionPolicy;
    repo?: InMemoryAuthRepository;
    random?: RandomSource;
  } = {},
): { service: AuthService; repo: InMemoryAuthRepository; random: SeqRandom } {
  const repo = overrides.repo ?? new InMemoryAuthRepository();
  const random = (overrides.random as SeqRandom) ?? new SeqRandom();
  const service = new AuthService({
    repo,
    hasher: fakeHasher,
    random,
    clock: overrides.clock ?? new MockClock(1_000_000),
    ...(overrides.policy ? { policy: overrides.policy } : {}),
    minPasswordLength: 8,
  });
  return { service, repo, random };
}

async function bootstrap(service: AuthService, password = 'correct-horse'): Promise<string> {
  const res = await service.bootstrapOwner({ username: 'owner', password });
  return res.recoveryCode;
}

describe('AuthService.bootstrapOwner', () => {
  it('rejects a weak (too-short) password before creating anything', async () => {
    const { service, repo } = makeService();
    await expect(
      service.bootstrapOwner({ username: 'owner', password: 'short' }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    expect(await repo.countOwners()).toBe(0);
  });

  it('is safe under a concurrent race: exactly one owner is created', async () => {
    const { service, repo } = makeService();
    const results = await Promise.allSettled([
      service.bootstrapOwner({ username: 'owner', password: 'correct-horse' }),
      service.bootstrapOwner({ username: 'owner', password: 'correct-horse' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OwnerExistsError);
    expect(await repo.countOwners()).toBe(1);
  });
});

describe('AuthService.login', () => {
  it('rejects a wrong password with a generic error', async () => {
    const { service } = makeService();
    await bootstrap(service);
    await expect(
      service.login({ username: 'owner', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects an unknown username with the same generic error', async () => {
    const { service } = makeService();
    await bootstrap(service);
    await expect(
      service.login({ username: 'ghost', password: 'correct-horse' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('issues a session with an opaque token + bound CSRF token on success', async () => {
    const { service } = makeService();
    await bootstrap(service);
    const result = await service.login({ username: 'owner', password: 'correct-horse' });
    expect(result.secrets.token).toMatch(/^tok-/);
    expect(result.secrets.csrfToken).toMatch(/^tok-/);
    expect(result.profile.username).toBe('owner');
    expect(result.profile.csrf_token).toBe(result.secrets.csrfToken);
    // A valid session validates back to the same owner.
    const ctx = await service.validateSession(result.secrets.token);
    expect(ctx.username).toBe('owner');
  });
});

describe('AuthService.validateSession expiry & sliding renewal', () => {
  it('rejects once idle expiry is reached', async () => {
    const clock = new MockClock(0);
    const { service } = makeService({ clock, policy: { idleTtlMs: 1000, absoluteTtlMs: 100_000 } });
    await bootstrap(service);
    const { secrets } = await service.login({ username: 'owner', password: 'correct-horse' });
    clock.set(1000); // exactly at expiresAt
    await expect(service.validateSession(secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
  });

  it('slides idle expiry forward on use', async () => {
    const clock = new MockClock(0);
    const { service } = makeService({ clock, policy: { idleTtlMs: 1000, absoluteTtlMs: 100_000 } });
    await bootstrap(service);
    const { secrets } = await service.login({ username: 'owner', password: 'correct-horse' });
    clock.set(500);
    await service.validateSession(secrets.token); // slides expiry to 1500
    clock.set(1200); // would have expired at 1000 without sliding
    const ctx = await service.validateSession(secrets.token);
    expect(ctx.ownerId).toBeTruthy();
  });

  it('caps sliding at the absolute lifetime', async () => {
    const clock = new MockClock(0);
    const { service } = makeService({ clock, policy: { idleTtlMs: 1000, absoluteTtlMs: 1500 } });
    await bootstrap(service);
    const { secrets } = await service.login({ username: 'owner', password: 'correct-horse' });
    clock.set(800);
    await service.validateSession(secrets.token); // within idle; slide capped at 1500, not 1800
    clock.set(1400);
    await service.validateSession(secrets.token); // still valid; slide stays capped at 1500
    clock.set(1500); // absolute cap reached
    await expect(service.validateSession(secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
  });
});

describe('AuthService logout & password lifecycle', () => {
  it('logout revokes the session server-side', async () => {
    const { service } = makeService();
    await bootstrap(service);
    const { secrets } = await service.login({ username: 'owner', password: 'correct-horse' });
    await service.logout(secrets.token);
    await expect(service.validateSession(secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
  });

  it('changePassword revokes ALL sessions and requires the current password', async () => {
    const { service, repo } = makeService();
    await bootstrap(service);
    const ownerId = (await repo.getSingletonOwner())!.id;
    const a = await service.login({ username: 'owner', password: 'correct-horse' });
    const b = await service.login({ username: 'owner', password: 'correct-horse' });

    await expect(
      service.changePassword({
        ownerId,
        currentPassword: 'nope-nope',
        newPassword: 'new-passphrase',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const { revokedSessions } = await service.changePassword({
      ownerId,
      currentPassword: 'correct-horse',
      newPassword: 'new-passphrase',
    });
    expect(revokedSessions).toBe(2);
    await expect(service.validateSession(a.secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
    await expect(service.validateSession(b.secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
    // New password works.
    await expect(
      service.login({ username: 'owner', password: 'new-passphrase' }),
    ).resolves.toBeTruthy();
  });

  it('recovery reset revokes sessions, and the recovery code is single-use', async () => {
    const { service } = makeService();
    const recoveryCode = await bootstrap(service);
    const s1 = await service.login({ username: 'owner', password: 'correct-horse' });

    const reset = await service.resetPasswordWithRecovery({
      recoveryCode,
      newPassword: 'brand-new-secret',
    });
    expect(reset.revokedSessions).toBe(1);
    await expect(service.validateSession(s1.secrets.token)).rejects.toBeInstanceOf(
      SessionInvalidError,
    );

    // Old recovery code no longer works (rotated); the new one does.
    await expect(
      service.resetPasswordWithRecovery({ recoveryCode, newPassword: 'another-secret' }),
    ).rejects.toBeInstanceOf(RecoveryInvalidError);
    await expect(
      service.resetPasswordWithRecovery({
        recoveryCode: reset.recoveryCode,
        newPassword: 'another-secret',
      }),
    ).resolves.toBeTruthy();
  });
});

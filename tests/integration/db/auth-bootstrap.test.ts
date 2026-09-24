import { describe, expect, it } from 'vitest';
import { HAS_DB, createTestDatabase } from './support.js';
import {
  AuthService,
  OwnerExistsError,
  createDbAuthRepository,
} from '../../../packages/application/src/index.js';
import { runBootstrap } from '../../../ops/bootstrap/runBootstrap.js';
import { runReset } from '../../../ops/bootstrap/runReset.js';

const d = HAS_DB ? describe : describe.skip;

d('owner bootstrap (T04, DB-backed)', () => {
  it('creates the singleton owner + Workspace + Inbox in one transaction', async () => {
    const db = await createTestDatabase();
    try {
      const service = new AuthService({ repo: createDbAuthRepository(db.pool) });
      const result = await service.bootstrapOwner({
        username: 'owner',
        password: 'correct-horse-battery',
      });
      expect(result.recoveryCode).toBeTruthy();

      const owners = await db.pool.query('SELECT count(*)::int AS n FROM owners');
      expect(owners.rows[0].n).toBe(1);
      const inbox = await db.pool.query(
        'SELECT is_inbox FROM projects WHERE id = $1',
        [result.inboxProjectId],
      );
      expect(inbox.rows[0].is_inbox).toBe(true);
      const ws = await db.pool.query('SELECT count(*)::int AS n FROM workspaces');
      expect(ws.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('refuses a second owner under a concurrent race (exactly one wins)', async () => {
    const db = await createTestDatabase();
    try {
      const service = new AuthService({ repo: createDbAuthRepository(db.pool) });
      const results = await Promise.allSettled([
        service.bootstrapOwner({ username: 'owner', password: 'correct-horse-battery' }),
        service.bootstrapOwner({ username: 'owner2', password: 'correct-horse-battery' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OwnerExistsError);
      const owners = await db.pool.query('SELECT count(*)::int AS n FROM owners');
      expect(owners.rows[0].n).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it('login → session validate works against a bootstrapped owner', async () => {
    const db = await createTestDatabase();
    try {
      const service = new AuthService({ repo: createDbAuthRepository(db.pool) });
      await service.bootstrapOwner({ username: 'owner', password: 'correct-horse-battery' });
      const { secrets } = await service.login({
        username: 'owner',
        password: 'correct-horse-battery',
      });
      const ctx = await service.validateSession(secrets.token);
      expect(ctx.username).toBe('owner');
    } finally {
      await db.drop();
    }
  });

  it('runBootstrap creates once, prints a recovery code, then refuses', async () => {
    const db = await createTestDatabase();
    try {
      const lines: string[] = [];
      const first = await runBootstrap({
        pool: db.pool,
        readPassword: () => Promise.resolve('correct-horse-battery'),
        output: (line) => lines.push(line),
      });
      expect(first.status).toBe('created');
      expect(lines.join('\n')).toContain(first.recoveryCode!);

      const second = await runBootstrap({
        pool: db.pool,
        readPassword: () => Promise.resolve('correct-horse-battery'),
        output: () => {},
      });
      expect(second.status).toBe('already_exists');
    } finally {
      await db.drop();
    }
  });

  it('runReset reverifies the recovery code, resets, revokes sessions and rotates it', async () => {
    const db = await createTestDatabase();
    try {
      const service = new AuthService({ repo: createDbAuthRepository(db.pool) });
      const boot = await service.bootstrapOwner({
        username: 'owner',
        password: 'correct-horse-battery',
      });
      const s = await service.login({ username: 'owner', password: 'correct-horse-battery' });

      const outcome = await runReset({
        pool: db.pool,
        readRecoveryCode: () => Promise.resolve(boot.recoveryCode),
        readNewPassword: () => Promise.resolve('a-brand-new-password'),
        output: () => {},
      });
      expect(outcome.status).toBe('reset');
      expect(outcome.revokedSessions).toBe(1);

      // Old session revoked; old password + old recovery code both dead; new ones work.
      await expect(service.validateSession(s.secrets.token)).rejects.toBeTruthy();
      await expect(
        service.login({ username: 'owner', password: 'correct-horse-battery' }),
      ).rejects.toBeTruthy();
      await expect(
        service.login({ username: 'owner', password: 'a-brand-new-password' }),
      ).resolves.toBeTruthy();

      const reused = await runReset({
        pool: db.pool,
        readRecoveryCode: () => Promise.resolve(boot.recoveryCode),
        readNewPassword: () => Promise.resolve('yet-another-password'),
        output: () => {},
      });
      expect(reused.status).toBe('invalid_recovery');
    } finally {
      await db.drop();
    }
  });
});

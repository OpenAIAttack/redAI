import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HAS_DB, createTestDatabase, insertBaseGraph, future } from './support.js';
import { SessionRepository } from '../../../packages/db/src/index.js';

const d = HAS_DB ? describe : describe.skip;

function h(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

d('SessionRepository (T04)', () => {
  it('stores only hashes and finds a session by its token hash', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const sessions = new SessionRepository(db.pool);
      const created = await sessions.create({
        workspaceId: base.workspaceId,
        ownerId: base.ownerId,
        tokenHash: h('token-a'),
        csrfHash: h('csrf-a'),
        expiresAt: future(12),
        absoluteExpiresAt: future(24 * 7),
      });
      expect(created.revoked_at).toBeNull();

      const found = await sessions.findByTokenHash(h('token-a'));
      expect(found?.id).toBe(created.id);
      expect(found?.csrf_hash.equals(h('csrf-a'))).toBe(true);
      expect(await sessions.findByTokenHash(h('nope'))).toBeNull();
    } finally {
      await db.drop();
    }
  });

  it('slides idle expiry via touch, rotates CSRF, and revokes', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const sessions = new SessionRepository(db.pool);
      const s = await sessions.create({
        workspaceId: base.workspaceId,
        ownerId: base.ownerId,
        tokenHash: h('token-b'),
        csrfHash: h('csrf-b'),
        expiresAt: future(1),
        absoluteExpiresAt: future(24 * 7),
      });

      const slid = future(6);
      await sessions.touch(s.id, new Date(), slid);
      await sessions.updateCsrf(s.id, h('csrf-b2'));
      const afterTouch = await sessions.findById(s.id);
      expect(afterTouch?.expires_at.getTime()).toBeCloseTo(slid.getTime(), -3);
      expect(afterTouch?.csrf_hash.equals(h('csrf-b2'))).toBe(true);

      await sessions.revoke(s.id, new Date());
      const afterRevoke = await sessions.findById(s.id);
      expect(afterRevoke?.revoked_at).not.toBeNull();
    } finally {
      await db.drop();
    }
  });

  it('revokeAllForOwner revokes every live session and reports the count', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const sessions = new SessionRepository(db.pool);
      for (const t of ['t1', 't2', 't3']) {
        await sessions.create({
          workspaceId: base.workspaceId,
          ownerId: base.ownerId,
          tokenHash: h(t),
          csrfHash: h(`csrf-${t}`),
          expiresAt: future(12),
          absoluteExpiresAt: future(24 * 7),
        });
      }
      const revoked = await sessions.revokeAllForOwner(base.ownerId, base.workspaceId, new Date());
      expect(revoked).toBe(3);
      // A second call revokes nothing (already revoked).
      expect(await sessions.revokeAllForOwner(base.ownerId, base.workspaceId, new Date())).toBe(0);
    } finally {
      await db.drop();
    }
  });

  it('enforces token_hash uniqueness and the expiry CHECK', async () => {
    const db = await createTestDatabase();
    try {
      const base = await insertBaseGraph(db.pool);
      const sessions = new SessionRepository(db.pool);
      await sessions.create({
        workspaceId: base.workspaceId,
        ownerId: base.ownerId,
        tokenHash: h('dup'),
        csrfHash: h('c'),
        expiresAt: future(12),
        absoluteExpiresAt: future(24 * 7),
      });
      await expect(
        sessions.create({
          workspaceId: base.workspaceId,
          ownerId: base.ownerId,
          tokenHash: h('dup'),
          csrfHash: h('c2'),
          expiresAt: future(12),
          absoluteExpiresAt: future(24 * 7),
        }),
      ).rejects.toMatchObject({ code: '23505' });

      // expires_at must be <= absolute_expires_at (schema CHECK).
      await expect(
        sessions.create({
          workspaceId: base.workspaceId,
          ownerId: base.ownerId,
          tokenHash: h('bad-window'),
          csrfHash: h('c3'),
          expiresAt: future(48),
          absoluteExpiresAt: future(1),
        }),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await db.drop();
    }
  });
});

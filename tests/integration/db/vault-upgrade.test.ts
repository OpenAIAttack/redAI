import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, HAS_DB, insertBaseGraph, type TestDatabase } from './support.js';
import { StaticMasterKeyProvider, deriveKeyId, SettingsService, createDbSettingsRepository } from '../../../packages/application/src/settings/index.js';
import { rewrapLegacySecrets } from '../../../ops/bootstrap/rewrapLegacySecrets.js';

describe.skipIf(!HAS_DB)('offline legacy vault upgrade', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db?.drop(); });
  it('rewraps verified legacy rows once and rejects moving the new ciphertext', async () => {
    const fx = await insertBaseGraph(db.pool);
    const key = randomBytes(32); const nonce = randomBytes(12);
    const aad = Buffer.from(JSON.stringify([fx.workspaceId, 'target_credential', 'legacy', 1]));
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update('SYNTHETIC_UPGRADE_CANARY'), cipher.final(), cipher.getAuthTag()]);
    const result = await db.pool.query<{ id: string }>(`INSERT INTO secrets (workspace_id, project_id, name, kind, version, ciphertext, nonce, key_id, aad_sha256, allowed_origins) VALUES ($1,$2,'legacy','target_credential',1,$3,$4,$5,$6,'[]') RETURNING id`, [fx.workspaceId, fx.projectId, ciphertext, nonce, deriveKeyId(key), createHash('sha256').update(aad).digest('hex')]);
    const id = result.rows[0]!.id;
    const keys = new StaticMasterKeyProvider(key);
    const svc = new SettingsService({ repo: createDbSettingsRepository(db.pool), masterKeys: keys });
    await expect(svc.resolveCredential({ workspaceId: fx.workspaceId, projectId: fx.projectId, secretId: id })).rejects.toThrow();
    expect(await rewrapLegacySecrets(db.pool, keys)).toBe(1);
    expect(await rewrapLegacySecrets(db.pool, keys)).toBe(0);
    expect(await svc.resolveCredential({ workspaceId: fx.workspaceId, projectId: fx.projectId, secretId: id })).toBe('SYNTHETIC_UPGRADE_CANARY');
    const other = await db.pool.query<{ id: string }>("INSERT INTO projects (workspace_id,name) VALUES ($1,'other') RETURNING id", [fx.workspaceId]);
    await db.pool.query('UPDATE secrets SET project_id=$2 WHERE id=$1', [id, other.rows[0]!.id]);
    await expect(svc.resolveCredential({ workspaceId: fx.workspaceId, projectId: other.rows[0]!.id, secretId: id })).rejects.toThrow();
  });
});

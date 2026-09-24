/**
 * Live-PostgreSQL integration for the DB-backed settings repository. Reuses the
 * throwaway-database helper from the T02 integration support (imported by relative
 * path so its `pg` resolves under vitest, matching the existing DB suites). Skips
 * LOUDLY when DATABASE_URL is unset; runs green against a real PG 16 cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  insertBaseGraph,
  HAS_DB,
  type Fixtures,
  type TestDatabase,
} from '../../../../tests/integration/db/support.js';
import { createDbSettingsRepository } from './settingsRepository.js';
import { SettingsService } from './service.js';
import { StaticMasterKeyProvider } from './masterKey.js';
import { RevisionConflictError } from './errors.js';

const MASTER_KEY = Buffer.alloc(32, 77);

describe.skipIf(!HAS_DB)('DbSettingsRepository (live PG)', () => {
  let db: TestDatabase;
  let fx: Fixtures;
  let svc: SettingsService;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await insertBaseGraph(db.pool);
    svc = new SettingsService({
      repo: createDbSettingsRepository(db.pool),
      masterKeys: new StaticMasterKeyProvider(MASTER_KEY),
    });
  });

  afterAll(async () => {
    if (db) await db.drop();
  });

  it('persists a secret honouring the schema CHECKs (nonce=12, aad regex) and round-trips it', async () => {
    const meta = await svc.createSecret({
      workspaceId: fx.workspaceId,
      name: 'openai',
      kind: 'model_api_key',
      plaintext: 'sk-live-db',
    });
    expect(meta.version).toBe(1);

    // The stored row never leaks plaintext, and the trusted path decrypts it.
    const value = await svc.resolveCredential({ workspaceId: fx.workspaceId, secretId: meta.id });
    expect(value).toBe('sk-live-db');

    const raw = await db.pool.query<{ nonce: Buffer; aad_sha256: string; ciphertext: Buffer }>(
      'SELECT nonce, aad_sha256, ciphertext FROM secrets WHERE id = $1',
      [meta.id],
    );
    expect(raw.rows[0]!.nonce.length).toBe(12);
    expect(raw.rows[0]!.aad_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.rows[0]!.ciphertext.includes(Buffer.from('sk-live-db'))).toBe(false);
  });

  it('increments version on replace of the same name/kind', async () => {
    const a = await svc.createSecret({
      workspaceId: fx.workspaceId,
      name: 'dup',
      kind: 'model_api_key',
      plaintext: '1',
    });
    const b = await svc.createSecret({
      workspaceId: fx.workspaceId,
      name: 'dup',
      kind: 'model_api_key',
      plaintext: '2',
    });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
  });

  it('persists a project-bound target credential and denies cross-project use', async () => {
    const meta = await svc.createSecret({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'target-ssh',
      kind: 'target_credential',
      plaintext: 'creds',
    });
    await expect(
      svc.resolveCredential({
        workspaceId: fx.workspaceId,
        secretId: meta.id,
        projectId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'CROSS_PROJECT_SECRET' });
    await expect(
      svc.resolveCredential({
        workspaceId: fx.workspaceId,
        secretId: meta.id,
        projectId: fx.projectId,
      }),
    ).resolves.toBe('creds');
  });

  it('atomically creates a provider config + secret and exposes only a reference', async () => {
    const view = await svc.createProviderConfig({
      workspaceId: fx.workspaceId,
      displayName: 'DB Provider',
      config: { adapter_kind: 'chat_completions', allowed_data_modes: ['redacted_cloud'] },
      apiKey: 'sk-provider-db',
    });
    expect(view.credential_ref).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain('sk-provider-db');

    // Both rows exist and are linked by the composite FK.
    const link = await db.pool.query<{ credential_ref: string }>(
      'SELECT credential_ref FROM provider_configs WHERE id = $1',
      [view.id],
    );
    expect(link.rows[0]!.credential_ref).toBe(view.credential_ref);
  });

  it('provider config update: matching revision succeeds, stale revision is a 409 conflict', async () => {
    const created = await svc.createProviderConfig({
      workspaceId: fx.workspaceId,
      displayName: 'v',
      config: {},
    });
    const updated = await svc.updateProviderConfig({
      workspaceId: fx.workspaceId,
      id: created.id,
      expectedRevision: created.revision,
      displayName: 'v-renamed',
    });
    expect(updated.revision).toBe(created.revision + 1);
    await expect(
      svc.updateProviderConfig({
        workspaceId: fx.workspaceId,
        id: created.id,
        expectedRevision: created.revision,
        displayName: 'stale',
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('workspace settings update: stale revision is a 409 conflict (no silent overwrite)', async () => {
    const before = await svc.getSettings(fx.workspaceId);
    const after = await svc.updateSettings(fx.workspaceId, before.revision, {
      data_mode: 'redacted_cloud',
    });
    expect(after.revision).toBe(before.revision + 1);
    await expect(
      svc.updateSettings(fx.workspaceId, before.revision, { data_mode: 'cloud_full' }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const current = await svc.getSettings(fx.workspaceId);
    expect(current.settings).toEqual({ data_mode: 'redacted_cloud' });
  });

  it('revoke is idempotent and blocks resolution', async () => {
    const meta = await svc.createSecret({
      workspaceId: fx.workspaceId,
      name: 'rev',
      kind: 'model_api_key',
      plaintext: 'x',
    });
    await svc.revokeSecret(fx.workspaceId, meta.id);
    await svc.revokeSecret(fx.workspaceId, meta.id); // idempotent
    await expect(
      svc.resolveCredential({ workspaceId: fx.workspaceId, secretId: meta.id }),
    ).rejects.toMatchObject({ code: 'SECRET_REVOKED' });
  });
});

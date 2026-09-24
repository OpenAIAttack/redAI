import { describe, expect, it } from 'vitest';
import { SettingsService } from './service.js';
import { InMemorySettingsRepository } from './memoryRepository.js';
import { StaticMasterKeyProvider } from './masterKey.js';
import {
  CrossProjectSecretError,
  ProjectRequiredError,
  ProviderConfigNotFoundError,
  RevisionConflictError,
  SecretOriginDeniedError,
  SecretRevokedError,
} from './errors.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeService(): { svc: SettingsService; repo: InMemorySettingsRepository } {
  const repo = new InMemorySettingsRepository();
  repo.seedWorkspace(WS, { theme: 'dark' }, 1);
  const svc = new SettingsService({
    repo,
    masterKeys: new StaticMasterKeyProvider(Buffer.alloc(32, 42)),
  });
  return { svc, repo };
}

describe('SettingsService secrets', () => {
  it('createSecret returns metadata only (no plaintext, no ciphertext)', async () => {
    const { svc } = makeService();
    const meta = await svc.createSecret({
      workspaceId: WS,
      name: 'openai',
      kind: 'model_api_key',
      plaintext: 'sk-live-abcdef',
    });
    expect(meta.name).toBe('openai');
    expect(meta.version).toBe(1);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('sk-live-abcdef');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('nonce');
  });

  it('versions bump on replace of the same name/kind', async () => {
    const { svc } = makeService();
    const v1 = await svc.createSecret({
      workspaceId: WS,
      name: 'k',
      kind: 'model_api_key',
      plaintext: 'a',
    });
    const v2 = await svc.createSecret({
      workspaceId: WS,
      name: 'k',
      kind: 'model_api_key',
      plaintext: 'b',
    });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  it('target_credential requires a project', async () => {
    const { svc } = makeService();
    await expect(
      svc.createSecret({ workspaceId: WS, name: 't', kind: 'target_credential', plaintext: 'x' }),
    ).rejects.toBeInstanceOf(ProjectRequiredError);
  });

  it('resolveCredential decrypts for the trusted executor path', async () => {
    const { svc, repo } = makeService();
    await svc.createSecret({
      workspaceId: WS,
      name: 'openai',
      kind: 'model_api_key',
      plaintext: 'sk-42',
    });
    const [meta] = await repo.listSecretMetadata(WS);
    const value = await svc.resolveCredential({ workspaceId: WS, secretId: meta!.id });
    expect(value).toBe('sk-42');
  });

  it('resolveCredential denies a cross-project project-bound secret', async () => {
    const { svc, repo } = makeService();
    await svc.createSecret({
      workspaceId: WS,
      projectId: PROJECT_A,
      name: 'ssh',
      kind: 'target_credential',
      plaintext: 'hunter2',
    });
    const [meta] = await repo.listSecretMetadata(WS);
    await expect(
      svc.resolveCredential({ workspaceId: WS, secretId: meta!.id, projectId: PROJECT_B }),
    ).rejects.toBeInstanceOf(CrossProjectSecretError);
    // Same project resolves fine.
    await expect(
      svc.resolveCredential({ workspaceId: WS, secretId: meta!.id, projectId: PROJECT_A }),
    ).resolves.toBe('hunter2');
  });

  it('resolveCredential enforces the allowed-origins allowlist', async () => {
    const { svc, repo } = makeService();
    await svc.createSecret({
      workspaceId: WS,
      projectId: PROJECT_A,
      name: 'http',
      kind: 'target_credential',
      plaintext: 'token',
      allowedOrigins: ['https://api.example.com'],
    });
    const [meta] = await repo.listSecretMetadata(WS);
    await expect(
      svc.resolveCredential({ workspaceId: WS, secretId: meta!.id, projectId: PROJECT_A }),
    ).rejects.toBeInstanceOf(SecretOriginDeniedError);
    await expect(
      svc.resolveCredential({
        workspaceId: WS,
        secretId: meta!.id,
        projectId: PROJECT_A,
        origin: 'https://api.example.com',
      }),
    ).resolves.toBe('token');
  });

  it('resolveCredential rejects a revoked secret', async () => {
    const { svc, repo } = makeService();
    await svc.createSecret({ workspaceId: WS, name: 'k', kind: 'model_api_key', plaintext: 'v' });
    const [meta] = await repo.listSecretMetadata(WS);
    await svc.revokeSecret(WS, meta!.id);
    await expect(
      svc.resolveCredential({ workspaceId: WS, secretId: meta!.id }),
    ).rejects.toBeInstanceOf(SecretRevokedError);
  });
});

describe('SettingsService provider configs', () => {
  it('creating with an inline api key returns only a reference + masked metadata', async () => {
    const { svc } = makeService();
    const view = await svc.createProviderConfig({
      workspaceId: WS,
      displayName: 'OpenAI',
      config: {
        adapter_kind: 'chat_completions',
        model_id: 'gpt-x',
        allowed_data_modes: ['redacted_cloud'],
      },
      apiKey: 'sk-secret-inline',
    });
    expect(view.credential_ref).toMatch(/[0-9a-f-]{36}/);
    expect(view.credential).not.toBeNull();
    expect(view.credential!.masked).not.toContain('sk-secret-inline');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('sk-secret-inline');
    // The stored secret can still be resolved by the trusted path.
    const resolved = await svc.resolveCredential({
      workspaceId: WS,
      secretId: view.credential_ref!,
    });
    expect(resolved).toBe('sk-secret-inline');
  });

  it('rejects an unknown credential_ref', async () => {
    const { svc } = makeService();
    await expect(
      svc.createProviderConfig({
        workspaceId: WS,
        displayName: 'x',
        config: {},
        credentialRef: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });
  });

  it('update with a stale revision throws a RevisionConflictError (→ 409)', async () => {
    const { svc } = makeService();
    const created = await svc.createProviderConfig({
      workspaceId: WS,
      displayName: 'p',
      config: {},
    });
    expect(created.revision).toBe(1);
    const updated = await svc.updateProviderConfig({
      workspaceId: WS,
      id: created.id,
      expectedRevision: 1,
      displayName: 'p2',
    });
    expect(updated.revision).toBe(2);
    // Second writer still thinks it is revision 1 → conflict.
    await expect(
      svc.updateProviderConfig({
        workspaceId: WS,
        id: created.id,
        expectedRevision: 1,
        displayName: 'p3',
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('getProviderConfig throws when absent', async () => {
    const { svc } = makeService();
    await expect(
      svc.getProviderConfig(WS, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    ).rejects.toBeInstanceOf(ProviderConfigNotFoundError);
  });
});

describe('SettingsService workspace settings (optimistic concurrency)', () => {
  it('reads and updates with a matching revision', async () => {
    const { svc } = makeService();
    const before = await svc.getSettings(WS);
    expect(before.revision).toBe(1);
    const after = await svc.updateSettings(WS, 1, { theme: 'light', language: 'vi' });
    expect(after.revision).toBe(2);
    expect(after.settings).toEqual({ theme: 'light', language: 'vi' });
  });

  it('a stale write is a 409 conflict, not a silent overwrite', async () => {
    const { svc } = makeService();
    await svc.updateSettings(WS, 1, { a: 1 });
    await expect(svc.updateSettings(WS, 1, { a: 2 })).rejects.toBeInstanceOf(RevisionConflictError);
    // The concurrent (winning) value survives.
    const current = await svc.getSettings(WS);
    expect(current.settings).toEqual({ a: 1 });
    expect(current.revision).toBe(2);
  });
});

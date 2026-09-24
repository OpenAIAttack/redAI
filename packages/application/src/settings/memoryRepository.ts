/**
 * In-memory {@link SettingsRepository} for unit tests and DB-free wiring. It mirrors
 * the DB adapter's contract: version derivation, atomic secret+config creation, and
 * optimistic-concurrency semantics (a stale `expectedRevision` yields `conflict`).
 *
 * Atomicity is trivial here (single-threaded, no `await` inside a critical section),
 * which is the in-process analogue of the DB adapter's `withTransaction`.
 */
import { randomUUID } from 'node:crypto';
import type {
  InsertProviderConfigInput,
  InsertSecretInput,
  OptimisticResult,
  ProviderConfigRecord,
  SecretKind,
  SecretMetadata,
  SecretRecord,
  SettingsRepository,
  UpdateProviderConfigPatch,
  WorkspaceSettingsRecord,
} from './ports.js';

function toMetadata(s: SecretRecord): SecretMetadata {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    projectId: s.projectId,
    name: s.name,
    kind: s.kind,
    version: s.version,
    allowedOrigins: s.allowedOrigins,
    revokedAt: s.revokedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export class InMemorySettingsRepository implements SettingsRepository {
  private readonly secrets = new Map<string, SecretRecord>();
  private readonly configs = new Map<string, ProviderConfigRecord>();
  private readonly workspaces = new Map<string, WorkspaceSettingsRecord>();

  /** Seed a workspace settings row (tests pre-create the workspace). */
  public seedWorkspace(
    workspaceId: string,
    settings: Record<string, unknown> = {},
    revision = 1,
  ): void {
    this.workspaces.set(workspaceId, { workspaceId, settings, revision });
  }

  nextSecretVersion(
    workspaceId: string,
    name: string,
    kind: SecretKind,
    projectId: string | null,
  ): Promise<number> {
    let max = 0;
    for (const s of this.secrets.values()) {
      if (
        s.workspaceId === workspaceId &&
        s.name === name &&
        s.kind === kind &&
        s.projectId === projectId
      ) {
        max = Math.max(max, s.version);
      }
    }
    return Promise.resolve(max + 1);
  }

  insertSecret(input: InsertSecretInput): Promise<SecretRecord> {
    const now = new Date();
    const record: SecretRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      version: input.version,
      ciphertext: input.material.ciphertext,
      nonce: input.material.nonce,
      keyId: input.material.keyId,
      aadSha256: input.material.aadSha256,
      allowedOrigins: input.allowedOrigins,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.secrets.set(record.id, record);
    return Promise.resolve(record);
  }

  getSecretById(id: string, workspaceId: string): Promise<SecretRecord | null> {
    const s = this.secrets.get(id);
    return Promise.resolve(s && s.workspaceId === workspaceId ? s : null);
  }

  listSecretMetadata(workspaceId: string): Promise<SecretMetadata[]> {
    const out: SecretMetadata[] = [];
    for (const s of this.secrets.values()) {
      if (s.workspaceId === workspaceId) out.push(toMetadata(s));
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(out);
  }

  revokeSecret(id: string, workspaceId: string, revokedAt: Date): Promise<boolean> {
    const s = this.secrets.get(id);
    if (!s || s.workspaceId !== workspaceId || s.revokedAt !== null) return Promise.resolve(false);
    s.revokedAt = revokedAt;
    s.updatedAt = revokedAt;
    return Promise.resolve(true);
  }

  insertProviderConfig(input: InsertProviderConfigInput): Promise<ProviderConfigRecord> {
    const now = new Date();
    const record: ProviderConfigRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      config: input.config,
      credentialRef: input.credentialRef,
      revision: 1,
      enabled: input.enabled,
      probeStatus: 'not_tested',
      lastProbeAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.configs.set(record.id, record);
    return Promise.resolve(record);
  }

  createProviderConfigWithSecret(
    secret: InsertSecretInput,
    config: Omit<InsertProviderConfigInput, 'credentialRef'>,
  ): Promise<{ config: ProviderConfigRecord; secretId: string }> {
    // Critical section: no await between the two inserts.
    const now = new Date();
    const secretRecord: SecretRecord = {
      id: randomUUID(),
      workspaceId: secret.workspaceId,
      projectId: secret.projectId,
      name: secret.name,
      kind: secret.kind,
      version: secret.version,
      ciphertext: secret.material.ciphertext,
      nonce: secret.material.nonce,
      keyId: secret.material.keyId,
      aadSha256: secret.material.aadSha256,
      allowedOrigins: secret.allowedOrigins,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.secrets.set(secretRecord.id, secretRecord);
    const configRecord: ProviderConfigRecord = {
      id: randomUUID(),
      workspaceId: config.workspaceId,
      displayName: config.displayName,
      config: config.config,
      credentialRef: secretRecord.id,
      revision: 1,
      enabled: config.enabled,
      probeStatus: 'not_tested',
      lastProbeAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.configs.set(configRecord.id, configRecord);
    return Promise.resolve({ config: configRecord, secretId: secretRecord.id });
  }

  getProviderConfigById(id: string, workspaceId: string): Promise<ProviderConfigRecord | null> {
    const c = this.configs.get(id);
    return Promise.resolve(c && c.workspaceId === workspaceId ? c : null);
  }

  listProviderConfigs(workspaceId: string): Promise<ProviderConfigRecord[]> {
    const out: ProviderConfigRecord[] = [];
    for (const c of this.configs.values()) {
      if (c.workspaceId === workspaceId) out.push(c);
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(out);
  }

  updateProviderConfig(
    id: string,
    workspaceId: string,
    expectedRevision: number,
    patch: UpdateProviderConfigPatch,
  ): Promise<OptimisticResult<ProviderConfigRecord>> {
    const c = this.configs.get(id);
    if (!c || c.workspaceId !== workspaceId) return Promise.resolve({ kind: 'not_found' });
    if (c.revision !== expectedRevision) {
      return Promise.resolve({ kind: 'conflict', currentRevision: c.revision });
    }
    if (patch.displayName !== undefined) c.displayName = patch.displayName;
    if (patch.config !== undefined) c.config = patch.config;
    if (patch.credentialRef !== undefined) c.credentialRef = patch.credentialRef;
    if (patch.enabled !== undefined) c.enabled = patch.enabled;
    c.revision += 1;
    c.updatedAt = new Date();
    return Promise.resolve({ kind: 'ok', value: c });
  }

  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsRecord | null> {
    const w = this.workspaces.get(workspaceId);
    return Promise.resolve(w ? { ...w } : null);
  }

  updateWorkspaceSettings(
    workspaceId: string,
    expectedRevision: number,
    settings: Record<string, unknown>,
    _updatedAt: Date,
  ): Promise<OptimisticResult<WorkspaceSettingsRecord>> {
    const w = this.workspaces.get(workspaceId);
    if (!w) return Promise.resolve({ kind: 'not_found' });
    if (w.revision !== expectedRevision) {
      return Promise.resolve({ kind: 'conflict', currentRevision: w.revision });
    }
    w.settings = settings;
    w.revision += 1;
    return Promise.resolve({ kind: 'ok', value: { ...w } });
  }
}

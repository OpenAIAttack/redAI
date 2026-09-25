import { validatePublicSettings, validateApiKey } from './validate.js';
import { randomUUID } from 'node:crypto';
/**
 * Settings + secret-vault use cases: create/list/revoke secrets, versioned provider
 * configs with a metadata-only credential reference, workspace settings with
 * optimistic-concurrency (revision / If-Match) conflict handling, and the
 * runtime-only credential resolution path that decrypts a secret for a provider
 * adapter. The logic is pure orchestration over injected ports (clock / random /
 * master key / repository), so the unit tests drive it entirely with fakes.
 *
 * Secrets discipline: a plaintext credential lives only as a method argument to
 * {@link SettingsService.createSecret} or a return value of
 * {@link SettingsService.resolveCredential} (the trusted-executor path). No API-facing
 * method returns plaintext, and nothing here logs a secret, key or ciphertext.
 */
import { nodeRandomSource, systemClock } from './crypto.js';
import {
  CredentialNotFoundError,
  CrossProjectSecretError,
  InvalidSettingsError,
  ProjectRequiredError,
  ProviderConfigNotFoundError,
  RevisionConflictError,
  SecretNotFoundError,
  SecretOriginDeniedError,
  SecretRevokedError,
} from './errors.js';
import { SecretVault } from './vault.js';
import type {
  Clock,
  MasterKeyProvider,
  ProviderConfigRecord,
  RandomSource,
  SecretKind,
  SecretMetadata,
  SecretRecord,
  SettingsRepository,
} from './ports.js';

export interface SettingsServiceDeps {
  repo: SettingsRepository;
  masterKeys: MasterKeyProvider;
  clock?: Clock;
  random?: RandomSource;
}

// --- JSON-safe views (never contain plaintext or cipher material) ------------

export interface SecretMetadataView {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  kind: SecretKind;
  version: number;
  allowed_origins: string[];
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfigView {
  id: string;
  workspace_id: string;
  display_name: string;
  config: Record<string, unknown>;
  credential_ref: string | null;
  /** Masked metadata of the referenced secret; NEVER its value. */
  credential: {
    ref: string;
    name: string;
    kind: SecretKind;
    version: number;
    masked: string;
    revoked: boolean;
  } | null;
  revision: number;
  enabled: boolean;
  probe_status: string;
  probe_result: Record<string, unknown> | null;
  last_probe_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceSettingsView {
  workspace_id: string;
  settings: Record<string, unknown>;
  revision: number;
}

export interface CreateSecretInput {
  workspaceId: string;
  projectId?: string | null;
  name: string;
  kind: SecretKind;
  /** Plaintext credential; consumed here, never stored or returned. */
  plaintext: string;
  allowedOrigins?: string[];
}

export interface CreateProviderConfigInput {
  workspaceId: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  /** Inline API key → a `model_api_key` secret is created and referenced. */
  apiKey?: string;
  /** Reference an existing secret in this workspace instead of an inline key. */
  credentialRef?: string | null;
}

export interface UpdateProviderConfigInput {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  displayName?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ResolveCredentialInput {
  workspaceId: string;
  secretId: string;
  /** The project the request is running in; enforced for project-bound secrets. */
  projectId?: string | null;
  /** The execution origin, matched against the secret's allowed-origins allowlist. */
  origin?: string;
}

const MASK = '••••••••';

function toSecretMetadataView(m: SecretMetadata): SecretMetadataView {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    project_id: m.projectId,
    name: m.name,
    kind: m.kind,
    version: m.version,
    allowed_origins: m.allowedOrigins,
    revoked: m.revokedAt !== null,
    revoked_at: m.revokedAt ? m.revokedAt.toISOString() : null,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
  };
}

export class SettingsService {
  private readonly repo: SettingsRepository;
  private readonly vault: SecretVault;
  private readonly clock: Clock;

  public constructor(deps: SettingsServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? systemClock;
    this.vault = new SecretVault(deps.masterKeys, deps.random ?? nodeRandomSource);
  }

  // --- secrets --------------------------------------------------------------

  /**
   * Create (or version-bump) a secret. Returns metadata only. A `target_credential`
   * MUST be project-bound (mirrors the schema CHECK). The next version is derived
   * from existing rows of the same (workspace, name, kind, project).
   */
  async createSecret(input: CreateSecretInput): Promise<SecretMetadataView> {
    const projectId = input.projectId ?? null;
    if (input.kind === 'target_credential' && projectId === null) {
      throw new ProjectRequiredError();
    }
    if (input.name.trim() === '') {
      throw new InvalidSettingsError('Secret name must not be empty.');
    }
    const version = await this.repo.nextSecretVersion(
      input.workspaceId,
      input.name,
      input.kind,
      projectId,
    );
    const id = randomUUID();
    const material = this.vault.encrypt(
      {
        workspaceId: input.workspaceId,
        secretId: id,
        projectId,
        kind: input.kind,
        name: input.name,
        version,
      },
      Buffer.from(input.plaintext, 'utf8'),
    );
    const record = await this.repo.insertSecret({
      id,
      workspaceId: input.workspaceId,
      projectId,
      name: input.name,
      kind: input.kind,
      version,
      allowedOrigins: input.allowedOrigins ?? [],
      material,
    });
    return toSecretMetadataView(record);
  }

  async listSecrets(workspaceId: string): Promise<SecretMetadataView[]> {
    const rows = await this.repo.listSecretMetadata(workspaceId);
    return rows.map(toSecretMetadataView);
  }

  async revokeSecret(workspaceId: string, id: string): Promise<void> {
    const ok = await this.repo.revokeSecret(id, workspaceId, this.clock.now());
    if (!ok) {
      // Either missing or already revoked; distinguish for a precise status.
      const existing = await this.repo.getSecretById(id, workspaceId);
      if (!existing) throw new SecretNotFoundError();
      // already revoked → idempotent success.
    }
  }

  /**
   * TRUSTED-EXECUTOR path (not exposed via the owner API): decrypt a secret so a
   * provider/target adapter can use it. Enforces revocation, cross-project binding
   * and the origin allowlist before opening the ciphertext.
   */
  async resolveCredential(input: ResolveCredentialInput): Promise<string> {
    const secret = await this.repo.getSecretById(input.secretId, input.workspaceId);
    if (!secret) throw new SecretNotFoundError();
    if (secret.revokedAt !== null) throw new SecretRevokedError();

    // Project-bound secret may only be used from its own project's context.
    if (secret.projectId !== null) {
      const requested = input.projectId ?? null;
      if (requested !== secret.projectId) throw new CrossProjectSecretError();
    }

    if (secret.allowedOrigins.length > 0) {
      if (input.origin === undefined || !secret.allowedOrigins.includes(input.origin)) {
        throw new SecretOriginDeniedError();
      }
    }

    const plaintext = this.vault.decrypt(
      {
        workspaceId: secret.workspaceId,
        secretId: secret.id,
        projectId: secret.projectId,
        kind: secret.kind,
        name: secret.name,
        version: secret.version,
      },
      {
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        keyId: secret.keyId,
        aadSha256: secret.aadSha256,
      },
    );
    return plaintext.toString('utf8');
  }

  // --- provider configs -----------------------------------------------------

  private async credentialMetaFor(
    workspaceId: string,
    credentialRef: string | null,
  ): Promise<ProviderConfigView['credential']> {
    if (credentialRef === null) return null;
    const secret = await this.repo.getSecretById(credentialRef, workspaceId);
    if (!secret) return null;
    return {
      ref: secret.id,
      name: secret.name,
      kind: secret.kind,
      version: secret.version,
      masked: MASK,
      revoked: secret.revokedAt !== null,
    };
  }

  private async toProviderConfigView(record: ProviderConfigRecord): Promise<ProviderConfigView> {
    return {
      id: record.id,
      workspace_id: record.workspaceId,
      display_name: record.displayName,
      config: record.config,
      credential_ref: record.credentialRef,
      credential: await this.credentialMetaFor(record.workspaceId, record.credentialRef),
      revision: record.revision,
      enabled: record.enabled,
      probe_status: record.probeStatus,
      probe_result: record.probeResult,
      last_probe_at: record.lastProbeAt ? record.lastProbeAt.toISOString() : null,
      created_at: record.createdAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
    };
  }

  async listProviderConfigs(workspaceId: string): Promise<ProviderConfigView[]> {
    const rows = await this.repo.listProviderConfigs(workspaceId);
    return Promise.all(rows.map((r) => this.toProviderConfigView(r)));
  }

  async getProviderConfig(workspaceId: string, id: string): Promise<ProviderConfigView> {
    const row = await this.repo.getProviderConfigById(id, workspaceId);
    if (!row) throw new ProviderConfigNotFoundError();
    return this.toProviderConfigView(row);
  }

  /**
   * Create a provider config. When `apiKey` is supplied, a `model_api_key` secret is
   * created and the config is linked to it ATOMICALLY. The returned view exposes only
   * the credential reference + masked metadata, never the key.
   */
  async createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfigView> {
    this.validateProviderConfig(input.config);
    if (input.apiKey !== undefined) validateApiKey(input.apiKey);
    if (input.apiKey && input.credentialRef)
      throw new InvalidSettingsError('Choose either api_key or credential_ref.');
    const enabled = input.enabled ?? true;

    if (input.apiKey !== undefined && input.apiKey !== '') {
      const version = await this.repo.nextSecretVersion(
        input.workspaceId,
        `provider:${input.displayName}`,
        'model_api_key',
        null,
      );
      const name = `provider:${input.displayName}`;
      const id = randomUUID();
      const material = this.vault.encrypt(
        {
          workspaceId: input.workspaceId,
          secretId: id,
          projectId: null,
          kind: 'model_api_key',
          name,
          version,
        },
        Buffer.from(input.apiKey, 'utf8'),
      );
      const { config } = await this.repo.createProviderConfigWithSecret(
        {
          id,
          workspaceId: input.workspaceId,
          projectId: null,
          name,
          kind: 'model_api_key',
          version,
          allowedOrigins: [],
          material,
        },
        {
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          config: input.config,
          enabled,
        },
      );
      return this.toProviderConfigView(config);
    }

    // Reference an existing secret (must exist in this workspace) or none.
    const credentialRef = input.credentialRef ?? null;
    if (credentialRef !== null) {
      const secret = await this.repo.getSecretById(credentialRef, input.workspaceId);
      if (!secret) throw new CredentialNotFoundError();
      if (secret.projectId !== null || secret.kind !== 'model_api_key')
        throw new CrossProjectSecretError();
      if (secret.revokedAt !== null) throw new SecretRevokedError();
    }
    const row = await this.repo.insertProviderConfig({
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      config: input.config,
      credentialRef,
      enabled,
    });
    return this.toProviderConfigView(row);
  }

  /** Update a provider config with an optimistic revision check (409 on stale). */
  async updateProviderConfig(input: UpdateProviderConfigInput): Promise<ProviderConfigView> {
    if (input.config !== undefined) this.validateProviderConfig(input.config);
    const patch: {
      displayName?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    } = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.config !== undefined) patch.config = input.config;
    if (input.enabled !== undefined) patch.enabled = input.enabled;

    const result = await this.repo.updateProviderConfig(
      input.id,
      input.workspaceId,
      input.expectedRevision,
      patch,
    );
    if (result.kind === 'not_found') throw new ProviderConfigNotFoundError();
    if (result.kind === 'conflict') {
      throw new RevisionConflictError(input.expectedRevision, result.currentRevision);
    }
    return this.toProviderConfigView(result.value);
  }

  private validateProviderConfig(config: Record<string, unknown>): void {
    validatePublicSettings(config);
    if (config.base_url !== undefined) {
      try {
        const url = new URL(String(config.base_url));
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        throw new InvalidSettingsError(
          'Provider endpoint must be HTTP(S), without credentials, query or fragment.',
        );
      }
    }
    const modes = config['allowed_data_modes'];
    if (modes !== undefined) {
      if (
        !Array.isArray(modes) ||
        !modes.every((m) => m === 'local_only' || m === 'redacted_cloud' || m === 'cloud_full')
      ) {
        throw new InvalidSettingsError(
          'allowed_data_modes must be a subset of the known data modes.',
        );
      }
    }
  }

  // --- workspace settings ---------------------------------------------------

  async getSettings(workspaceId: string): Promise<WorkspaceSettingsView> {
    const row = await this.repo.getWorkspaceSettings(workspaceId);
    if (!row) throw new InvalidSettingsError('Workspace not found.');
    return { workspace_id: row.workspaceId, settings: row.settings, revision: row.revision };
  }

  /**
   * Replace the workspace settings blob with an optimistic revision check. A stale
   * `expectedRevision` throws {@link RevisionConflictError} (mapped to 409) instead of
   * silently overwriting a concurrent change (docs/13 §7 acceptance).
   */
  async updateSettings(
    workspaceId: string,
    expectedRevision: number,
    settings: Record<string, unknown>,
  ): Promise<WorkspaceSettingsView> {
    validatePublicSettings(settings);
    const result = await this.repo.updateWorkspaceSettings(
      workspaceId,
      expectedRevision,
      settings,
      this.clock.now(),
    );
    if (result.kind === 'not_found') throw new InvalidSettingsError('Workspace not found.');
    if (result.kind === 'conflict') {
      throw new RevisionConflictError(expectedRevision, result.currentRevision);
    }
    return {
      workspace_id: result.value.workspaceId,
      settings: result.value.settings,
      revision: result.value.revision,
    };
  }
}

export type { SecretRecord };

/**
 * Injected collaborators and storage-neutral record shapes for the settings +
 * secret-vault use cases. Mirroring the auth package's port style (architecture §9),
 * time / randomness / the master-key source sit behind tiny interfaces so the unit
 * tests drive them with fakes while production wires the real `node:crypto` and
 * key-file implementations. No `pg` / `@redai/db` type ever leaks across this seam.
 */

/** Monotonic source of "now"; the only way a use case learns the wall clock. */
export interface Clock {
  now(): Date;
}

/** Cryptographically strong randomness for AEAD nonces and identifiers. */
export interface RandomSource {
  /** `n` random bytes (AEAD nonces use 12). */
  bytes(n: number): Buffer;
  /** A random UUID (v4). */
  uuid(): string;
}

/** A resolved master key plus the stable id that binds every ciphertext to it. */
export interface MasterKeyMaterial {
  /** Deterministic id derived from the key material (never the key itself). */
  keyId: string;
  /** 32-byte AES-256 key. */
  key: Buffer;
}

/**
 * Source of the AEAD master key. Production loads it from a key file outside the DB
 * and git (docs/11 §8); the id is derived from the key content so a *different* key
 * yields a *different* id and old ciphertext fails to decrypt loudly rather than
 * being silently re-keyed. A missing key file is a hard error (locked), never a
 * freshly-minted key (docs/13 §7 acceptance).
 */
export interface MasterKeyProvider {
  /** The active key for new encryptions. Throws {@link MasterKeyUnavailableError} when locked. */
  activeKey(): MasterKeyMaterial;
  /**
   * The key matching `keyId`, or `null` when this provider cannot supply it (a
   * decrypt against an unknown key id must fail, not fall back to the active key).
   */
  keyById(keyId: string): Buffer | null;
}

// --- storage records (DB-shape neutral) -------------------------------------

export type SecretKind = 'model_api_key' | 'target_credential';

/** The at-rest ciphertext material plus binding metadata; never holds plaintext. */
export interface SecretCipherMaterial {
  ciphertext: Buffer;
  /** 12-byte AES-GCM nonce/IV. */
  nonce: Buffer;
  /** Id of the master key the ciphertext is sealed under. */
  keyId: string;
  /** Lowercase hex SHA-256 of the canonical AAD (binds workspace|kind|name|version). */
  aadSha256: string;
}

export interface InsertSecretInput {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  kind: SecretKind;
  version: number;
  allowedOrigins: string[];
  material: SecretCipherMaterial;
}

/** Full secret row as persisted (includes cipher material; never returned to the API). */
export interface SecretRecord {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  kind: SecretKind;
  version: number;
  ciphertext: Buffer;
  nonce: Buffer;
  keyId: string;
  aadSha256: string;
  allowedOrigins: string[];
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Metadata-only projection safe to surface (docs/13 §5: name/type/created, never value). */
export interface SecretMetadata {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  kind: SecretKind;
  version: number;
  allowedOrigins: string[];
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderConfigRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  revision: number;
  enabled: boolean;
  probeStatus: string;
  probeResult: Record<string, unknown> | null;
  lastProbeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertProviderConfigInput {
  workspaceId: string;
  displayName: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  enabled: boolean;
}

export interface UpdateProviderConfigPatch {
  displayName?: string;
  config?: Record<string, unknown>;
  /** Present iff the caller wants to change the credential reference (null clears it). */
  credentialRef?: string | null;
  enabled?: boolean;
}

export interface WorkspaceSettingsRecord {
  workspaceId: string;
  settings: Record<string, unknown>;
  revision: number;
}

/** Outcome of an optimistic-concurrency update: hit, revision conflict, or absent row. */
export type OptimisticResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'conflict'; readonly currentRevision: number }
  | { readonly kind: 'not_found' };

/**
 * Storage port for the settings + secret use cases. The DB adapter owns its
 * transaction boundaries; `createProviderConfigWithSecret` MUST insert the secret
 * and the provider config atomically so a config never references a missing secret.
 */
export interface SettingsRepository {
  // secrets
  nextSecretVersion(
    workspaceId: string,
    name: string,
    kind: SecretKind,
    projectId: string | null,
  ): Promise<number>;
  insertSecret(input: InsertSecretInput): Promise<SecretRecord>;
  getSecretById(id: string, workspaceId: string): Promise<SecretRecord | null>;
  listSecretMetadata(workspaceId: string): Promise<SecretMetadata[]>;
  /** Revoke a live secret. Returns false when it was missing or already revoked. */
  revokeSecret(id: string, workspaceId: string, revokedAt: Date): Promise<boolean>;

  // provider configs
  insertProviderConfig(input: InsertProviderConfigInput): Promise<ProviderConfigRecord>;
  /** Atomic secret + provider-config creation (returns the created config). */
  createProviderConfigWithSecret(
    secret: InsertSecretInput,
    config: Omit<InsertProviderConfigInput, 'credentialRef'>,
  ): Promise<{ config: ProviderConfigRecord; secretId: string }>;
  getProviderConfigById(id: string, workspaceId: string): Promise<ProviderConfigRecord | null>;
  listProviderConfigs(workspaceId: string): Promise<ProviderConfigRecord[]>;
  updateProviderConfig(
    id: string,
    workspaceId: string,
    expectedRevision: number,
    patch: UpdateProviderConfigPatch,
  ): Promise<OptimisticResult<ProviderConfigRecord>>;

  // workspace settings
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsRecord | null>;
  updateWorkspaceSettings(
    workspaceId: string,
    expectedRevision: number,
    settings: Record<string, unknown>,
    updatedAt: Date,
  ): Promise<OptimisticResult<WorkspaceSettingsRecord>>;
}

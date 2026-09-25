/**
 * @redai/application settings barrel — secret vault, versioned provider/model
 * configs and workspace settings with optimistic concurrency. The API layer and
 * runtime provider adapters consume these use cases; only ciphertext + binding
 * metadata cross into `@redai/db`, and no plaintext secret crosses into the API.
 *
 * NOTE: the package-level barrel (`packages/application/src/index.ts`) is wired by
 * the coordinator; this file is the module's own public surface.
 */

export {
  SettingsService,
  type SettingsServiceDeps,
  type SecretMetadataView,
  type ProviderConfigView,
  type WorkspaceSettingsView,
  type CreateSecretInput,
  type CreateProviderConfigInput,
  type UpdateProviderConfigInput,
  type ResolveCredentialInput,
} from './service.js';

export {
  SettingsError,
  isSettingsError,
  MasterKeyUnavailableError,
  SecretDecryptError,
  SecretNotFoundError,
  SecretRevokedError,
  CrossProjectSecretError,
  SecretOriginDeniedError,
  ProjectRequiredError,
  ProviderConfigNotFoundError,
  CredentialNotFoundError,
  RevisionConflictError,
  InvalidSettingsError,
} from './errors.js';
export type { SettingsErrorCode } from './errors.js';

export { SecretVault, canonicalAad, VAULT_NONCE_BYTES, VAULT_TAG_BYTES } from './vault.js';
export type { SecretIdentity } from './vault.js';

export {
  FileMasterKeyProvider,
  StaticMasterKeyProvider,
  createFileMasterKeyProvider,
  deriveKeyId,
  parseKeyMaterial,
} from './masterKey.js';
export type { FileMasterKeyOptions } from './masterKey.js';

export { systemClock, nodeRandomSource, sha256Hex, constantTimeEqual } from './crypto.js';

export { createDbSettingsRepository } from './settingsRepository.js';
export { InMemorySettingsRepository } from './memoryRepository.js';

export type {
  Clock,
  RandomSource,
  MasterKeyProvider,
  MasterKeyMaterial,
  SecretKind,
  SecretRecord,
  SecretMetadata,
  SecretCipherMaterial,
  ProviderConfigRecord,
  WorkspaceSettingsRecord,
  SettingsRepository,
  OptimisticResult,
} from './ports.js';

export { ProviderProbeService } from './probeService.js';
export { createDbProbeStore, type ProbeStore, type ProbeIdentity } from './probeStore.js';

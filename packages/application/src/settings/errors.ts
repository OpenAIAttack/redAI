/**
 * Typed settings / vault failures. Each carries a stable `code` (mapped to the HTTP
 * error envelope by the API layer via {@link isSettingsError}) and NEVER embeds a
 * plaintext secret, key or ciphertext in its message — messages are safe to log.
 */

export type SettingsErrorCode =
  | 'MASTER_KEY_UNAVAILABLE'
  | 'SECRET_DECRYPT_FAILED'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_REVOKED'
  | 'CROSS_PROJECT_SECRET'
  | 'SECRET_ORIGIN_DENIED'
  | 'PROJECT_REQUIRED'
  | 'PROVIDER_CONFIG_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'INVALID_SETTINGS'
  | 'PROBE_IN_PROGRESS'
  | 'IDEMPOTENCY_CONFLICT';

export class SettingsError extends Error {
  /** Marker used for cross-package detection without importing the class. */
  public readonly isSettingsError = true as const;
  public readonly code: SettingsErrorCode;
  public constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

/** Type guard usable across package boundaries (the API layer never imports this class directly). */
export function isSettingsError(err: unknown): err is { code: SettingsErrorCode; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isSettingsError?: unknown }).isSettingsError === true &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

/** The master key file is missing/unreadable/invalid — the vault is LOCKED, not re-keyed. */
export class MasterKeyUnavailableError extends SettingsError {
  public constructor(message = 'Master key is unavailable; secret store is locked.') {
    super('MASTER_KEY_UNAVAILABLE', message);
    this.name = 'MasterKeyUnavailableError';
  }
}

/** AEAD open failed: wrong key, wrong AAD, or tampered ciphertext/tag. */
export class SecretDecryptError extends SettingsError {
  public constructor(message = 'Secret could not be decrypted.') {
    super('SECRET_DECRYPT_FAILED', message);
    this.name = 'SecretDecryptError';
  }
}

export class SecretNotFoundError extends SettingsError {
  public constructor() {
    super('SECRET_NOT_FOUND', 'Secret not found.');
    this.name = 'SecretNotFoundError';
  }
}

export class SecretRevokedError extends SettingsError {
  public constructor() {
    super('SECRET_REVOKED', 'Secret has been revoked.');
    this.name = 'SecretRevokedError';
  }
}

/** A project-bound secret was requested from a different project's context (docs/13 §5). */
export class CrossProjectSecretError extends SettingsError {
  public constructor() {
    super('CROSS_PROJECT_SECRET', 'Secret belongs to a different project.');
    this.name = 'CrossProjectSecretError';
  }
}

/** The retrieval origin is not in the secret's allowed-origins allowlist. */
export class SecretOriginDeniedError extends SettingsError {
  public constructor() {
    super('SECRET_ORIGIN_DENIED', 'Retrieval origin is not allowed for this secret.');
    this.name = 'SecretOriginDeniedError';
  }
}

/** A `target_credential` secret was created without a project (schema CHECK mirror). */
export class ProjectRequiredError extends SettingsError {
  public constructor() {
    super('PROJECT_REQUIRED', 'A target credential must be bound to a project.');
    this.name = 'ProjectRequiredError';
  }
}

export class ProviderConfigNotFoundError extends SettingsError {
  public constructor() {
    super('PROVIDER_CONFIG_NOT_FOUND', 'Provider config not found.');
    this.name = 'ProviderConfigNotFoundError';
  }
}

/** A credential_ref pointed at a secret that does not exist in this workspace. */
export class CredentialNotFoundError extends SettingsError {
  public constructor() {
    super('CREDENTIAL_NOT_FOUND', 'Referenced credential secret was not found.');
    this.name = 'CredentialNotFoundError';
  }
}

/** Optimistic-concurrency mismatch: the caller's expected revision is stale. */
export class RevisionConflictError extends SettingsError {
  public readonly expectedRevision: number;
  public readonly currentRevision: number;
  public constructor(expectedRevision: number, currentRevision: number) {
    super(
      'REVISION_CONFLICT',
      `Stale write: expected revision ${expectedRevision} but current is ${currentRevision}.`,
    );
    this.name = 'RevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** Settings/config failed a domain validation rule beyond JSON-Schema shape. */
export class InvalidSettingsError extends SettingsError {
  public constructor(message: string) {
    super('INVALID_SETTINGS', message);
    this.name = 'InvalidSettingsError';
  }
}

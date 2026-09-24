/**
 * Typed auth failures. These carry a stable `code` (mapped to the HTTP error
 * envelope by the API layer) and NEVER embed a password, token or recovery code in
 * their message — messages are safe to log.
 */

export type AuthErrorCode =
  | 'OWNER_EXISTS'
  | 'INVALID_CREDENTIALS'
  | 'SESSION_INVALID'
  | 'RECOVERY_INVALID'
  | 'NOT_BOOTSTRAPPED'
  | 'WEAK_PASSWORD';

export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Bootstrap attempted against an install that already has an owner (incl. the race loser). */
export class OwnerExistsError extends AuthError {
  public constructor() {
    super('OWNER_EXISTS', 'An owner already exists; refusing to create a second owner.');
    this.name = 'OwnerExistsError';
  }
}

/** Generic invalid-credentials — deliberately does not say whether the user exists. */
export class InvalidCredentialsError extends AuthError {
  public constructor() {
    super('INVALID_CREDENTIALS', 'Invalid credentials.');
    this.name = 'InvalidCredentialsError';
  }
}

/** No session, revoked, or expired (idle or absolute). */
export class SessionInvalidError extends AuthError {
  public constructor(message = 'Session is missing, revoked or expired.') {
    super('SESSION_INVALID', message);
    this.name = 'SessionInvalidError';
  }
}

/** Recovery code did not match (already used, since a use rotates the hash). */
export class RecoveryInvalidError extends AuthError {
  public constructor() {
    super('RECOVERY_INVALID', 'Recovery code is invalid.');
    this.name = 'RecoveryInvalidError';
  }
}

/** Recovery/reset attempted before the install was bootstrapped. */
export class NotBootstrappedError extends AuthError {
  public constructor() {
    super('NOT_BOOTSTRAPPED', 'No owner exists yet; bootstrap first.');
    this.name = 'NotBootstrappedError';
  }
}

/** New/initial password does not meet the minimum-length policy. */
export class WeakPasswordError extends AuthError {
  public readonly minLength: number;
  public constructor(minLength: number) {
    super('WEAK_PASSWORD', `Password must be at least ${minLength} characters.`);
    this.name = 'WeakPasswordError';
    this.minLength = minLength;
  }
}

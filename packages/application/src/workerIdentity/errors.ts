/**
 * Typed worker-identity failures. Each carries a stable `code` (mapped to the HTTP
 * error envelope by the API layer) and NEVER embeds an enrollment token or worker
 * credential in its message — messages are safe to log (docs/08 §1: no token in log).
 */

export type WorkerIdentityErrorCode =
  | 'ENROLLMENT_INVALID'
  | 'ENROLLMENT_EXPIRED'
  | 'ENROLLMENT_ALREADY_CONSUMED'
  | 'WORKER_CREDENTIAL_INVALID'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_REVOKED';

export class WorkerIdentityError extends Error {
  public readonly code: WorkerIdentityErrorCode;
  public constructor(code: WorkerIdentityErrorCode, message: string) {
    super(message);
    this.name = 'WorkerIdentityError';
    this.code = code;
  }
}

/** The presented enrollment token does not match any issued token. */
export class EnrollmentInvalidError extends WorkerIdentityError {
  public constructor() {
    super('ENROLLMENT_INVALID', 'Enrollment token is invalid.');
    this.name = 'EnrollmentInvalidError';
  }
}

/** The enrollment token matched but is past its TTL (docs/08: 10 minutes). */
export class EnrollmentExpiredError extends WorkerIdentityError {
  public constructor() {
    super('ENROLLMENT_EXPIRED', 'Enrollment token has expired.');
    this.name = 'EnrollmentExpiredError';
  }
}

/**
 * The enrollment token was already redeemed. One-use enforcement (docs/08 §2:
 * "token replay reject") — a second redemption never mints a second worker.
 */
export class EnrollmentAlreadyConsumedError extends WorkerIdentityError {
  public constructor() {
    super('ENROLLMENT_ALREADY_CONSUMED', 'Enrollment token has already been used.');
    this.name = 'EnrollmentAlreadyConsumedError';
  }
}

/** Presented worker credential is unknown, expired, revoked, or its worker is revoked. */
export class WorkerCredentialInvalidError extends WorkerIdentityError {
  public constructor(message = 'Worker credential is invalid.') {
    super('WORKER_CREDENTIAL_INVALID', message);
    this.name = 'WorkerCredentialInvalidError';
  }
}

/** No worker with the given id in the workspace. */
export class WorkerNotFoundError extends WorkerIdentityError {
  public constructor() {
    super('WORKER_NOT_FOUND', 'Worker not found.');
    this.name = 'WorkerNotFoundError';
  }
}

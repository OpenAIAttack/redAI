/**
 * Typed scheduler failures. Each carries a stable `code` mapped to the worker error
 * envelope by the API layer. Messages never embed a bearer, lease JWS or credential
 * (AGENTS.md: no secret in log/URL).
 */

export type ExecutionErrorCode =
  | 'SESSION_SUPERSEDED'
  | 'STALE_FENCE'
  | 'RESULT_CONFLICT'
  | 'ATTEMPT_NOT_FOUND'
  | 'LEASE_REFUSED'
  | 'ARTIFACT_NOT_LINKED'
  | 'CAPABILITY_INVALID';

export class ExecutionError extends Error {
  public readonly code: ExecutionErrorCode;
  public constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

/** The presented `session_id` is not the worker's active session (docs/08 §2). */
export class SessionSupersededError extends ExecutionError {
  public constructor() {
    super('SESSION_SUPERSEDED', 'Worker session has been superseded.');
    this.name = 'SessionSupersededError';
  }
}

/** The write carries a stale fence for the tool call — rejected (docs/08 §6/§9). */
export class StaleFenceError extends ExecutionError {
  public readonly currentFence: string;
  public constructor(currentFence: string) {
    super('STALE_FENCE', 'Fencing token is stale.');
    this.name = 'StaleFenceError';
    this.currentFence = currentFence;
  }
}

/** A different result digest was already recorded for this attempt (docs/08 §9). */
export class ResultConflictError extends ExecutionError {
  public constructor() {
    super('RESULT_CONFLICT', 'A conflicting result was already recorded.');
    this.name = 'ResultConflictError';
  }
}

export class AttemptNotFoundError extends ExecutionError {
  public constructor() {
    super('ATTEMPT_NOT_FOUND', 'Task attempt not found.');
    this.name = 'AttemptNotFoundError';
  }
}

/**
 * Renewal refused: revoked/expired grant, superseded session, a bumped policy epoch,
 * or an already-expired lease. The worker must stop, not keep the task alive
 * (docs/08 §4). `reason` is a safe reason code, never a secret.
 */
export class LeaseRefusedError extends ExecutionError {
  public readonly reason: string;
  public constructor(reason: string) {
    super('LEASE_REFUSED', 'Lease renewal refused.');
    this.name = 'LeaseRefusedError';
    this.reason = reason;
  }
}

export class ArtifactNotLinkedError extends ExecutionError {
  public constructor() {
    super('ARTIFACT_NOT_LINKED', 'Artifact is not an input of this attempt.');
    this.name = 'ArtifactNotLinkedError';
  }
}

export class CapabilityInvalidError extends ExecutionError {
  public constructor(message = 'Credential capability is invalid or expired.') {
    super('CAPABILITY_INVALID', message);
    this.name = 'CapabilityInvalidError';
  }
}

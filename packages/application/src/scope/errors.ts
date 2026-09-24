/**
 * Typed failures for the DNS-proof / scope-version / grant use cases. Each carries a
 * stable `code` the API maps to the redAI error envelope + an HTTP status. Messages
 * embed no secrets, tokens or target content, so they are safe to log (AGENTS.md).
 */

export type ScopeErrorCode =
  | 'INVALID_ROOT'
  | 'PUBLIC_SUFFIX_ROOT'
  | 'DNS_PROOF_NOT_FOUND'
  | 'DNS_PROOF_EXPIRED'
  | 'DNS_PROOF_NOT_PENDING'
  | 'DNS_PROOF_MISMATCH'
  | 'INVALID_SCOPE'
  | 'SCOPE_VERSION_NOT_FOUND'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_PROOF_REQUIRED'
  | 'GRANT_PROOF_SCOPE_MISMATCH'
  | 'LAB_ATTESTATION_MISUSE'
  | 'GRANT_ALREADY_REVOKED';

export class ScopeError extends Error {
  public readonly code: ScopeErrorCode;
  public readonly httpStatus: number;
  public constructor(code: ScopeErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class InvalidRootError extends ScopeError {
  public constructor() {
    super('INVALID_ROOT', 422, 'Root domain is not a valid ASCII hostname.');
    this.name = 'InvalidRootError';
  }
}

/** A public suffix (e.g. `com`, `co.uk`) can never be an organizational root (docs/10 §2). */
export class PublicSuffixRootError extends ScopeError {
  public constructor() {
    super('PUBLIC_SUFFIX_ROOT', 422, 'A public suffix cannot be used as an organizational root.');
    this.name = 'PublicSuffixRootError';
  }
}

export class DnsProofNotFoundError extends ScopeError {
  public constructor() {
    super('DNS_PROOF_NOT_FOUND', 404, 'DNS challenge not found in this project.');
    this.name = 'DnsProofNotFoundError';
  }
}

export class DnsProofExpiredError extends ScopeError {
  public constructor() {
    super('DNS_PROOF_EXPIRED', 409, 'DNS challenge has expired; issue a new one.');
    this.name = 'DnsProofExpiredError';
  }
}

export class DnsProofNotPendingError extends ScopeError {
  public constructor() {
    super('DNS_PROOF_NOT_PENDING', 409, 'DNS challenge is not pending verification.');
    this.name = 'DnsProofNotPendingError';
  }
}

/** The expected TXT value was not observed at the challenge record (control not proven). */
export class DnsProofMismatchError extends ScopeError {
  public constructor() {
    super('DNS_PROOF_MISMATCH', 422, 'Challenge TXT record was not found; control not proven.');
    this.name = 'DnsProofMismatchError';
  }
}

/** The authored scope failed contract validation (schema). */
export class InvalidScopeError extends ScopeError {
  public readonly detail: string;
  public constructor(detail: string) {
    super('INVALID_SCOPE', 422, 'Scope failed contract validation.');
    this.name = 'InvalidScopeError';
    this.detail = detail;
  }
}

export class ScopeVersionNotFoundError extends ScopeError {
  public constructor() {
    super('SCOPE_VERSION_NOT_FOUND', 404, 'Scope version not found in this project.');
    this.name = 'ScopeVersionNotFoundError';
  }
}

export class GrantNotFoundError extends ScopeError {
  public constructor() {
    super('GRANT_NOT_FOUND', 404, 'Authorization grant not found in this project.');
    this.name = 'GrantNotFoundError';
  }
}

/** A public-host grant requires a verified DNS proof (docs/10 §3). */
export class GrantProofRequiredError extends ScopeError {
  public constructor() {
    super('GRANT_PROOF_REQUIRED', 422, 'A verified DNS proof is required for these hosts.');
    this.name = 'GrantProofRequiredError';
  }
}

/** The verified proof's root does not cover one of the authored hosts. */
export class GrantProofScopeMismatchError extends ScopeError {
  public constructor() {
    super('GRANT_PROOF_SCOPE_MISMATCH', 422, 'DNS proof root does not cover an authored host.');
    this.name = 'GrantProofScopeMismatchError';
  }
}

/** `lab_attestation` used with a DNS proof or with non-lab (public) rules (docs/10 §3). */
export class LabAttestationMisuseError extends ScopeError {
  public constructor(message = 'lab_attestation is only for explicit private-zone lab rules.') {
    super('LAB_ATTESTATION_MISUSE', 422, message);
    this.name = 'LabAttestationMisuseError';
  }
}

export class GrantAlreadyRevokedError extends ScopeError {
  public constructor() {
    super('GRANT_ALREADY_REVOKED', 409, 'Grant is already revoked.');
    this.name = 'GrantAlreadyRevokedError';
  }
}

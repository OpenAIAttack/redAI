/**
 * Injected collaborators for the auth use cases. Keeping time, hashing and
 * randomness behind tiny interfaces (architecture §9) lets the unit tests drive a
 * deterministic mock clock, a fast fake hasher and a scripted random source, while
 * production wires the real `node:crypto` implementations from `./crypto.js`.
 */

/** Monotonic source of "now"; the only way a use case learns the wall clock. */
export interface Clock {
  now(): Date;
}

/** A password KDF. `hash` is slow-by-design; `verify` is constant-time internally. */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
}

/** Cryptographically strong randomness for opaque tokens and recovery codes. */
export interface RandomSource {
  /** `byteLength` random bytes encoded base64url (no padding). Default 32 (256-bit). */
  token(byteLength?: number): string;
  /** A 256-bit recovery code in a readable, normalized alphabet. */
  recoveryCode(): string;
  /** A random UUID (v4), e.g. for a Workspace `installation_id`. */
  uuid(): string;
}

/** Idle / absolute session lifetimes. Defaults come from docs/13 (12h idle, 7d absolute). */
export interface SessionPolicy {
  readonly idleTtlMs: number;
  readonly absoluteTtlMs: number;
}

// --- storage records (DB-shape neutral: no `pg`/`@redai/db` types leak here) ---

export interface OwnerRecord {
  id: string;
  workspaceId: string;
  username: string;
  passwordHash: string;
  recoveryCodeHash: Buffer;
  passwordChangedAt: Date;
}

export interface SessionRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  csrfHash: Buffer;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export interface BootstrapInput {
  username: string;
  passwordHash: string;
  recoveryCodeHash: Buffer;
  workspaceName: string;
  installationId: string;
  inboxName: string;
}

export interface BootstrapResult {
  workspaceId: string;
  ownerId: string;
  inboxProjectId: string;
}

export interface CreateSessionRecord {
  workspaceId: string;
  ownerId: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Storage port for the auth use cases. Implementations own their own transaction
 * boundaries: `bootstrap`, `changePassword` and `resetPasswordWithRecovery` MUST be
 * atomic (create-graph / update-and-revoke). The DB adapter uses `withTransaction`;
 * the in-memory fake simulates the same atomicity and the singleton race.
 */
export interface AuthRepository {
  /** Number of owner rows (0 before bootstrap, 1 after). */
  countOwners(): Promise<number>;
  getOwnerByUsername(username: string): Promise<OwnerRecord | null>;
  getOwnerById(id: string): Promise<OwnerRecord | null>;
  /** The single owner, if bootstrapped (recovery/reset paths operate on it). */
  getSingletonOwner(): Promise<OwnerRecord | null>;

  /**
   * Create Workspace + owner + Inbox project atomically. Throws {@link OwnerExistsError}
   * when an owner already exists — including the concurrent-race case, where the DB
   * singleton/unique constraints let exactly one caller win.
   */
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;

  createSession(input: CreateSessionRecord): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null>;
  touchSession(id: string, lastSeenAt: Date, expiresAt: Date): Promise<void>;
  /** Rotate the CSRF token bound to a session (session-introspection cold-load). */
  updateSessionCsrf(id: string, csrfHash: Buffer): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;
  revokeAllOwnerSessions(ownerId: string, workspaceId: string, revokedAt: Date): Promise<number>;

  /** Atomic: set the new password hash AND revoke every live session for the owner. */
  changePassword(
    ownerId: string,
    workspaceId: string,
    passwordHash: string,
    changedAt: Date,
  ): Promise<number>;

  /** Atomic: rotate password + recovery-code hash AND revoke every live session. */
  resetPasswordWithRecovery(
    ownerId: string,
    workspaceId: string,
    passwordHash: string,
    recoveryCodeHash: Buffer,
    changedAt: Date,
  ): Promise<number>;
}

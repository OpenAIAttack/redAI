/**
 * Owner authentication use cases: bootstrap, login, session validation with
 * idle+absolute expiry and sliding renewal, logout, password change and
 * recovery-code reset. The logic is pure orchestration over injected ports
 * (clock / hasher / random / repository); it opens no sockets and reads no globals,
 * so the unit tests drive it entirely with fakes.
 *
 * Secrets discipline: a plaintext password or recovery code lives only as a method
 * argument. Only hashes are handed to the repository, and no plaintext is placed in
 * a return value except the one-time secrets the caller must surface once (the
 * recovery code at bootstrap/reset, and the freshly minted opaque token/CSRF token).
 */
import {
  cryptoRandom,
  hashRecoveryCode,
  hashToken,
  scryptHasher,
  systemClock,
  constantTimeEqual,
} from './crypto.js';
import {
  InvalidCredentialsError,
  NotBootstrappedError,
  RecoveryInvalidError,
  SessionInvalidError,
  WeakPasswordError,
} from './errors.js';
import type {
  AuthRepository,
  Clock,
  PasswordHasher,
  RandomSource,
  SessionPolicy,
} from './ports.js';

/** docs/13: idle 12h, absolute 7d. SPEC_LOCK's timeouts are for Runs, not sessions. */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTtlMs: 12 * 60 * 60 * 1000,
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
};

/** Minimum password length. docs/13 gives no explicit floor; 8 is the OWASP minimum. */
export const MIN_PASSWORD_LENGTH = 8;

export interface AuthServiceDeps {
  repo: AuthRepository;
  clock?: Clock;
  hasher?: PasswordHasher;
  random?: RandomSource;
  policy?: SessionPolicy;
  minPasswordLength?: number;
}

export interface BootstrapOwnerInput {
  username: string;
  password: string;
  workspaceName?: string;
  installationId?: string;
  inboxName?: string;
}

export interface BootstrapOwnerResult {
  workspaceId: string;
  ownerId: string;
  inboxProjectId: string;
  /** Shown to the operator exactly once; only its hash is stored. */
  recoveryCode: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface SessionSecrets {
  /** Opaque session token to set as the session cookie. */
  token: string;
  /** CSRF token bound to the session, echoed by the client on mutations. */
  csrfToken: string;
}

export interface SessionProfile {
  owner_id: string;
  workspace_id: string;
  username: string;
  csrf_token: string;
  expires_at: string;
  setup_complete: boolean;
}

export interface LoginResult {
  secrets: SessionSecrets;
  profile: SessionProfile;
}

export interface SessionContext {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  username: string;
  csrfHash: Buffer;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface ChangePasswordInput {
  ownerId: string;
  currentPassword: string;
  newPassword: string;
}

export interface ResetWithRecoveryInput {
  recoveryCode: string;
  newPassword: string;
}

export interface ResetResult {
  /** The rotated recovery code (single-use: the old one no longer verifies). */
  recoveryCode: string;
  revokedSessions: number;
}

export class AuthService {
  private readonly repo: AuthRepository;
  private readonly clock: Clock;
  private readonly hasher: PasswordHasher;
  private readonly random: RandomSource;
  private readonly policy: SessionPolicy;
  private readonly minPasswordLength: number;
  /** Lazily-computed decoy hash so a login for an unknown user still spends KDF time. */
  private decoyHash: string | null = null;

  public constructor(deps: AuthServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? systemClock;
    this.hasher = deps.hasher ?? scryptHasher;
    this.random = deps.random ?? cryptoRandom;
    this.policy = deps.policy ?? DEFAULT_SESSION_POLICY;
    this.minPasswordLength = deps.minPasswordLength ?? MIN_PASSWORD_LENGTH;
  }

  private assertPasswordStrength(password: string): void {
    if (password.length < this.minPasswordLength) {
      throw new WeakPasswordError(this.minPasswordLength);
    }
  }

  async bootstrapOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    this.assertPasswordStrength(input.password);

    const passwordHash = await this.hasher.hash(input.password);
    const recoveryCode = this.random.recoveryCode();
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);

    // Atomic create; on a concurrent second attempt the DB singleton/unique
    // constraints make the loser throw OwnerExistsError (never a second owner).
    const result = await this.repo.bootstrap({
      username: input.username,
      passwordHash,
      recoveryCodeHash,
      workspaceName: input.workspaceName ?? 'redAI',
      installationId: input.installationId ?? this.random.uuid(),
      inboxName: input.inboxName ?? 'Inbox',
    });

    return {
      workspaceId: result.workspaceId,
      ownerId: result.ownerId,
      inboxProjectId: result.inboxProjectId,
      recoveryCode,
    };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const owner = await this.repo.getOwnerByUsername(input.username);
    if (!owner) {
      // Equalize timing against the real-owner path; result is discarded.
      await this.hasher.verify(input.password, await this.getDecoyHash());
      throw new InvalidCredentialsError();
    }
    const ok = await this.hasher.verify(input.password, owner.passwordHash);
    if (!ok) throw new InvalidCredentialsError();

    return this.issueSession(owner.id, owner.workspaceId, owner.username);
  }

  private async getDecoyHash(): Promise<string> {
    if (this.decoyHash === null) {
      this.decoyHash = await this.hasher.hash('\u0000decoy-timing-equalizer');
    }
    return this.decoyHash;
  }

  /** Mint a fresh session (used by login and after a password reset that re-authenticates). */
  private async issueSession(
    ownerId: string,
    workspaceId: string,
    username: string,
  ): Promise<LoginResult> {
    const token = this.random.token(32);
    const csrfToken = this.random.token(32);
    const now = this.clock.now();
    const idleExpiry = new Date(now.getTime() + this.policy.idleTtlMs);
    const absoluteExpiry = new Date(now.getTime() + this.policy.absoluteTtlMs);
    const expiresAt = idleExpiry < absoluteExpiry ? idleExpiry : absoluteExpiry;

    const session = await this.repo.createSession({
      workspaceId,
      ownerId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt,
      absoluteExpiresAt: absoluteExpiry,
    });

    return {
      secrets: { token, csrfToken },
      profile: {
        owner_id: ownerId,
        workspace_id: workspaceId,
        username,
        csrf_token: csrfToken,
        expires_at: session.expiresAt.toISOString(),
        setup_complete: true,
      },
    };
  }

  /**
   * Validate an opaque session token. Throws {@link SessionInvalidError} when the
   * session is missing, revoked, idle-expired or past its absolute cap. On success
   * it slides idle expiry forward (bounded by the absolute cap) and returns the
   * session context — including `csrfHash` for the double-submit check.
   */
  async validateSession(rawToken: string): Promise<SessionContext> {
    const session = await this.repo.findSessionByTokenHash(hashToken(rawToken));
    if (!session) throw new SessionInvalidError('No matching session.');
    if (session.revokedAt !== null) throw new SessionInvalidError('Session revoked.');

    const now = this.clock.now();
    if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
      throw new SessionInvalidError('Session past absolute lifetime.');
    }
    if (now.getTime() >= session.expiresAt.getTime()) {
      throw new SessionInvalidError('Session idle-expired.');
    }

    // Sliding renewal, capped at the absolute expiry.
    const slid = new Date(now.getTime() + this.policy.idleTtlMs);
    const nextExpiry = slid < session.absoluteExpiresAt ? slid : session.absoluteExpiresAt;
    await this.repo.touchSession(session.id, now, nextExpiry);

    const owner = await this.repo.getOwnerById(session.ownerId);
    return {
      sessionId: session.id,
      ownerId: session.ownerId,
      workspaceId: session.workspaceId,
      username: owner?.username ?? '',
      csrfHash: session.csrfHash,
      expiresAt: nextExpiry,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  /** Build the safe session profile plus a usable CSRF token from a validated context. */
  profileFromContext(ctx: SessionContext, csrfToken: string): SessionProfile {
    return {
      owner_id: ctx.ownerId,
      workspace_id: ctx.workspaceId,
      username: ctx.username,
      csrf_token: csrfToken,
      expires_at: ctx.expiresAt.toISOString(),
      setup_complete: true,
    };
  }

  /**
   * Mint a fresh CSRF token for an existing session and persist its hash. Used by
   * session-introspection when the client no longer holds the CSRF cookie.
   */
  async rotateSessionCsrf(sessionId: string): Promise<string> {
    const csrfToken = this.random.token(32);
    await this.repo.updateSessionCsrf(sessionId, hashToken(csrfToken));
    return csrfToken;
  }

  /** Revoke a single session by its opaque token (logout). Idempotent. */
  async logout(rawToken: string): Promise<void> {
    const session = await this.repo.findSessionByTokenHash(hashToken(rawToken));
    if (!session || session.revokedAt !== null) return;
    await this.repo.revokeSession(session.id, this.clock.now());
  }

  /** Authenticated password change: verifies current, sets new, revokes ALL sessions. */
  async changePassword(input: ChangePasswordInput): Promise<{ revokedSessions: number }> {
    const owner = await this.repo.getOwnerById(input.ownerId);
    if (!owner) throw new InvalidCredentialsError();
    const ok = await this.hasher.verify(input.currentPassword, owner.passwordHash);
    if (!ok) throw new InvalidCredentialsError();
    this.assertPasswordStrength(input.newPassword);

    const passwordHash = await this.hasher.hash(input.newPassword);
    const revokedSessions = await this.repo.changePassword(
      owner.id,
      owner.workspaceId,
      passwordHash,
      this.clock.now(),
    );
    return { revokedSessions };
  }

  /**
   * CLI recovery path: verify the recovery code (constant time), set the new
   * password, rotate the recovery code (single-use) and revoke all sessions.
   */
  async resetPasswordWithRecovery(input: ResetWithRecoveryInput): Promise<ResetResult> {
    const owner = await this.repo.getSingletonOwner();
    if (!owner) throw new NotBootstrappedError();
    if (!constantTimeEqual(hashRecoveryCode(input.recoveryCode), owner.recoveryCodeHash)) {
      throw new RecoveryInvalidError();
    }
    this.assertPasswordStrength(input.newPassword);

    const passwordHash = await this.hasher.hash(input.newPassword);
    const newRecoveryCode = this.random.recoveryCode();
    const newRecoveryHash = hashRecoveryCode(newRecoveryCode);
    const revokedSessions = await this.repo.resetPasswordWithRecovery(
      owner.id,
      owner.workspaceId,
      passwordHash,
      newRecoveryHash,
      this.clock.now(),
    );
    return { recoveryCode: newRecoveryCode, revokedSessions };
  }
}

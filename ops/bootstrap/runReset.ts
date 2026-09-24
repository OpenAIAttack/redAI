/**
 * Owner password reset core (host recovery path, docs/13 §1). Verifies the recovery
 * code, sets a new password, rotates the recovery code (single-use) and revokes every
 * session — all atomically inside the use case. The recovery code and new password
 * arrive via injected readers (the CLI reads them from stdin, never argv/env) and are
 * never returned, logged or embedded anywhere. The new recovery code is surfaced once.
 */
import {
  AuthService,
  NotBootstrappedError,
  RecoveryInvalidError,
  WeakPasswordError,
  createDbAuthRepository,
} from '../../packages/application/src/index.js';
import type { Pool } from '../../packages/db/src/index.js';

export interface RunResetDeps {
  pool: Pool;
  readRecoveryCode: () => Promise<string>;
  readNewPassword: () => Promise<string>;
  output?: (line: string) => void;
}

export type ResetStatus = 'reset' | 'not_bootstrapped' | 'invalid_recovery' | 'weak_password';

export interface ResetOutcome {
  status: ResetStatus;
  revokedSessions?: number;
  /** New recovery code, present only when `status === 'reset'`; shown once. */
  recoveryCode?: string;
}

export async function runReset(deps: RunResetDeps): Promise<ResetOutcome> {
  const auth = new AuthService({ repo: createDbAuthRepository(deps.pool) });
  const recoveryCode = await deps.readRecoveryCode();
  const newPassword = await deps.readNewPassword();
  try {
    const result = await auth.resetPasswordWithRecovery({ recoveryCode, newPassword });
    const emit = deps.output ?? ((): void => {});
    emit(`Password reset. Revoked ${result.revokedSessions} active session(s).`);
    emit('New recovery code (the old one no longer works) — save it now, shown only once:');
    emit('');
    emit(`  ${result.recoveryCode}`);
    return {
      status: 'reset',
      revokedSessions: result.revokedSessions,
      recoveryCode: result.recoveryCode,
    };
  } catch (err) {
    if (err instanceof NotBootstrappedError) return { status: 'not_bootstrapped' };
    if (err instanceof RecoveryInvalidError) return { status: 'invalid_recovery' };
    if (err instanceof WeakPasswordError) return { status: 'weak_password' };
    throw err;
  }
}

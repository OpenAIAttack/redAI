/**
 * Owner bootstrap core (import-time side-effect free, so it is unit-testable).
 *
 * Creates the singleton owner + Workspace + Inbox project in one transaction and
 * surfaces the one-time recovery code. Refuses when an owner already exists — there
 * is no public signup and no default credentials. The password is provided by the
 * injected `readPassword` (the CLI reads it from stdin, never argv/env), and this
 * function never returns, logs or embeds the password anywhere.
 *
 * `@redai/application` / `@redai/db` are imported by relative path to their sources
 * (the repo's established pattern for the non-package `ops/` and `tests/` trees).
 */
import {
  AuthService,
  OwnerExistsError,
  createDbAuthRepository,
} from '../../packages/application/src/index.js';
import type { Pool } from '../../packages/db/src/index.js';

export interface RunBootstrapDeps {
  pool: Pool;
  /** Returns the initial password. The CLI wires this to a secure stdin read. */
  readPassword: () => Promise<string>;
  /** Sink for human-facing lines (the recovery code). Defaults to nothing. */
  output?: (line: string) => void;
  username?: string;
  workspaceName?: string;
}

export type BootstrapStatus = 'created' | 'already_exists';

export interface BootstrapOutcome {
  status: BootstrapStatus;
  ownerId?: string;
  workspaceId?: string;
  inboxProjectId?: string;
  /** Present only when `status === 'created'`; shown to the operator exactly once. */
  recoveryCode?: string;
}

export async function runBootstrap(deps: RunBootstrapDeps): Promise<BootstrapOutcome> {
  const repo = createDbAuthRepository(deps.pool);

  // Friendly fast-path refusal; the true concurrent-race guard is the DB singleton
  // constraint, surfaced below as OwnerExistsError.
  if ((await repo.countOwners()) > 0) {
    return { status: 'already_exists' };
  }

  const password = await deps.readPassword();
  const auth = new AuthService({ repo });

  try {
    const result = await auth.bootstrapOwner({
      username: deps.username ?? 'owner',
      password,
      ...(deps.workspaceName !== undefined ? { workspaceName: deps.workspaceName } : {}),
    });
    const emit = deps.output ?? ((): void => {});
    emit('Owner created. Save this recovery code now — it is shown only once:');
    emit('');
    emit(`  ${result.recoveryCode}`);
    emit('');
    emit('Store it offline. Losing it means recovery requires host database access.');
    return {
      status: 'created',
      ownerId: result.ownerId,
      workspaceId: result.workspaceId,
      inboxProjectId: result.inboxProjectId,
      recoveryCode: result.recoveryCode,
    };
  } catch (err) {
    if (err instanceof OwnerExistsError) return { status: 'already_exists' };
    throw err;
  }
}

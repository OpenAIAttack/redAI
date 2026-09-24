/**
 * @redai/db — versioned SQL migrations, a typed transaction wrapper and repositories.
 *
 * No ORM: schema change happens only through the explicit migration runner. This
 * package depends only on `@redai/domain` (kept pure) and `pg`.
 */

export const DB_PACKAGE = '@redai/db';

// connection + execution
export { createPool, pingDatabase } from './pool.js';
export type { Executor, CreatePoolOptions, Pool, PoolClient, QueryResult, QueryResultRow } from './pool.js';

// transactions
export { withTransaction } from './transaction.js';
export type { Tx, TransactionOptions, IsolationLevel } from './transaction.js';

// migrations
export { migrate, loadMigrations, defaultMigrationsDir } from './migrate.js';
export type { Migration, AppliedMigration, MigrateResult } from './migrate.js';

// event counter (INV-009)
export { appendEvent } from './events.js';
export type { AppendEventInput } from './events.js';

// repositories
export { WorkspaceRepository } from './repositories/workspaces.js';
export type { CreateWorkspaceInput } from './repositories/workspaces.js';
export { OwnerRepository } from './repositories/owners.js';
export type { CreateOwnerInput } from './repositories/owners.js';
export { ProjectRepository } from './repositories/projects.js';
export type { CreateProjectInput } from './repositories/projects.js';
export { ChatRepository } from './repositories/chats.js';
export type { CreateChatInput } from './repositories/chats.js';
export { RunRepository } from './repositories/runs.js';
export type { CreateRunInput } from './repositories/runs.js';
export { ProviderConfigRepository } from './repositories/providerConfigs.js';
export type { CreateProviderConfigInput, ProviderConfigRow } from './repositories/providerConfigs.js';

// seed fixtures
export { seedOwnerAndProject } from './seed.js';
export type { SeedInput, SeedResult } from './seed.js';

// shared row + enum types
export * from './types.js';

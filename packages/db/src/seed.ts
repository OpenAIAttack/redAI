/**
 * Seed fixtures: the minimum durable state a fresh single-owner install needs —
 * one workspace, its owner, a system Inbox project and one normal project. Runs in
 * a single transaction so a partial seed never lands. Idempotent-ish: it assumes an
 * empty install and will fail (by design) on the singleton/unique constraints if run
 * twice, rather than silently duplicating.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from './transaction.js';
import { WorkspaceRepository } from './repositories/workspaces.js';
import { OwnerRepository } from './repositories/owners.js';
import { ProjectRepository } from './repositories/projects.js';
import type { OwnerRow, ProjectRow, WorkspaceRow } from './types.js';

export interface SeedInput {
  workspaceName?: string;
  installationId?: string;
  ownerUsername?: string;
  /** Pre-hashed password (the DB never sees a plaintext password). */
  passwordHash?: string;
  /** Pre-hashed recovery code. */
  recoveryCodeHash?: Buffer;
}

export interface SeedResult {
  workspace: WorkspaceRow;
  owner: OwnerRow;
  inbox: ProjectRow;
  project: ProjectRow;
}

/** Insert the baseline fixtures. Test/dev only — production onboarding sets real secrets. */
export async function seedOwnerAndProject(pool: Pool, input: SeedInput = {}): Promise<SeedResult> {
  return withTransaction(pool, async (tx) => {
    const workspaces = new WorkspaceRepository(tx);
    const owners = new OwnerRepository(tx);
    const projects = new ProjectRepository(tx);

    const workspace = await workspaces.create({
      name: input.workspaceName ?? 'redAI',
      installationId: input.installationId ?? randomUUID(),
    });

    const owner = await owners.create({
      workspaceId: workspace.id,
      username: input.ownerUsername ?? 'owner',
      passwordHash: input.passwordHash ?? 'seed:not-a-real-hash',
      recoveryCodeHash: input.recoveryCodeHash ?? Buffer.from('seed:not-a-real-recovery-hash'),
    });

    const inbox = await projects.create({
      workspaceId: workspace.id,
      name: 'Inbox',
      description: 'System inbox project',
      isInbox: true,
    });

    const project = await projects.create({
      workspaceId: workspace.id,
      name: 'Sample Project',
      description: 'Seed project for local development',
    });

    return { workspace, owner, inbox, project };
  });
}

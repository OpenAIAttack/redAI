/**
 * DB-backed {@link SettingsRepository} bridging the settings use cases to `@redai/db`.
 * This is the production adapter (unit tests use the in-memory fake). Transaction
 * boundaries live here: `createProviderConfigWithSecret` inserts the secret and the
 * provider config inside one `withTransaction`, so a config never lands referencing a
 * missing secret. `bigint` revision/version columns arrive as strings from `pg`
 * (its OID-20 parser), so we normalize them to `number` at this seam.
 */
import { withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
import type {
  InsertProviderConfigInput,
  InsertSecretInput,
  OptimisticResult,
  ProviderConfigRecord,
  SecretKind,
  SecretMetadata,
  SecretRecord,
  SettingsRepository,
  UpdateProviderConfigPatch,
  WorkspaceSettingsRecord,
} from './ports.js';

interface SecretRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  kind: SecretKind;
  version: number | string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  aad_sha256: string;
  allowed_origins: unknown;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SecretMetadataRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  kind: SecretKind;
  version: number | string;
  allowed_origins: unknown;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ProviderConfigRow {
  id: string;
  workspace_id: string;
  display_name: string;
  config: Record<string, unknown>;
  credential_ref: string | null;
  revision: number | string;
  enabled: boolean;
  probe_status: string;
  probe_result: Record<string, unknown> | null;
  last_probe_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkspaceSettingsRow {
  id: string;
  settings: Record<string, unknown>;
  revision: number | string;
}

function toInt(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function toOrigins(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toSecretRecord(row: SecretRow): SecretRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    version: toInt(row.version),
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyId: row.key_id,
    aadSha256: row.aad_sha256,
    allowedOrigins: toOrigins(row.allowed_origins),
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSecretMetadata(row: SecretMetadataRow): SecretMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    version: toInt(row.version),
    allowedOrigins: toOrigins(row.allowed_origins),
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProviderConfigRecord(row: ProviderConfigRow): ProviderConfigRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    config: row.config,
    credentialRef: row.credential_ref,
    revision: toInt(row.revision),
    enabled: row.enabled,
    probeStatus: row.probe_status,
    probeResult: row.probe_result,
    lastProbeAt: row.last_probe_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertSecretRow(exec: Executor, input: InsertSecretInput): Promise<SecretRow> {
  const result = await exec.query<SecretRow>(
    `INSERT INTO secrets
       (workspace_id, project_id, name, kind, version, ciphertext, nonce, key_id, aad_sha256, allowed_origins, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING *`,
    [
      input.workspaceId,
      input.projectId,
      input.name,
      input.kind,
      input.version,
      input.material.ciphertext,
      input.material.nonce,
      input.material.keyId,
      input.material.aadSha256,
      JSON.stringify(input.allowedOrigins),
      input.id,
    ],
  );
  return required(result.rows[0], 'secret insert returned no row');
}

export function createDbSettingsRepository(pool: Pool): SettingsRepository {
  return {
    async nextSecretVersion(
      workspaceId: string,
      name: string,
      kind: SecretKind,
      projectId: string | null,
    ): Promise<number> {
      const result = await pool.query<{ v: number | string }>(
        `SELECT COALESCE(MAX(version), 0) AS v
           FROM secrets
          WHERE workspace_id = $1 AND name = $2 AND kind = $3
            AND project_id IS NOT DISTINCT FROM $4`,
        [workspaceId, name, kind, projectId],
      );
      return toInt(result.rows[0]?.v ?? 0) + 1;
    },

    async insertSecret(input: InsertSecretInput): Promise<SecretRecord> {
      return toSecretRecord(await insertSecretRow(pool, input));
    },

    async getSecretById(id: string, workspaceId: string): Promise<SecretRecord | null> {
      const result = await pool.query<SecretRow>(
        `SELECT * FROM secrets WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      const row = result.rows[0];
      return row ? toSecretRecord(row) : null;
    },

    async listSecretMetadata(workspaceId: string): Promise<SecretMetadata[]> {
      // Deliberately never SELECT ciphertext/nonce here — metadata only (docs/13 §5).
      const result = await pool.query<SecretMetadataRow>(
        `SELECT id, workspace_id, project_id, name, kind, version, allowed_origins,
                revoked_at, created_at, updated_at
           FROM secrets
          WHERE workspace_id = $1
          ORDER BY created_at DESC`,
        [workspaceId],
      );
      return result.rows.map(toSecretMetadata);
    },

    async revokeSecret(id: string, workspaceId: string, revokedAt: Date): Promise<boolean> {
      const result = await pool.query(
        `UPDATE secrets SET revoked_at = $3, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
        [id, workspaceId, revokedAt],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async insertProviderConfig(input: InsertProviderConfigInput): Promise<ProviderConfigRecord> {
      const result = await pool.query<ProviderConfigRow>(
        `INSERT INTO provider_configs (workspace_id, display_name, config, credential_ref, enabled)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [
          input.workspaceId,
          input.displayName,
          JSON.stringify(input.config),
          input.credentialRef,
          input.enabled,
        ],
      );
      return toProviderConfigRecord(
        required(result.rows[0], 'provider_config insert returned no row'),
      );
    },

    async createProviderConfigWithSecret(
      secret: InsertSecretInput,
      config: Omit<InsertProviderConfigInput, 'credentialRef'>,
    ): Promise<{ config: ProviderConfigRecord; secretId: string }> {
      return withTransaction(pool, async (tx) => {
        const secretRow = await insertSecretRow(tx, secret);
        const result = await tx.query<ProviderConfigRow>(
          `INSERT INTO provider_configs (workspace_id, display_name, config, credential_ref, enabled)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           RETURNING *`,
          [
            config.workspaceId,
            config.displayName,
            JSON.stringify(config.config),
            secretRow.id,
            config.enabled,
          ],
        );
        const configRow = required(result.rows[0], 'provider_config insert returned no row');
        return { config: toProviderConfigRecord(configRow), secretId: secretRow.id };
      });
    },

    async getProviderConfigById(
      id: string,
      workspaceId: string,
    ): Promise<ProviderConfigRecord | null> {
      const result = await pool.query<ProviderConfigRow>(
        `SELECT * FROM provider_configs WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      const row = result.rows[0];
      return row ? toProviderConfigRecord(row) : null;
    },

    async listProviderConfigs(workspaceId: string): Promise<ProviderConfigRecord[]> {
      const result = await pool.query<ProviderConfigRow>(
        `SELECT * FROM provider_configs WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId],
      );
      return result.rows.map(toProviderConfigRecord);
    },

    async updateProviderConfig(
      id: string,
      workspaceId: string,
      expectedRevision: number,
      patch: UpdateProviderConfigPatch,
    ): Promise<OptimisticResult<ProviderConfigRecord>> {
      const setCredential = Object.prototype.hasOwnProperty.call(patch, 'credentialRef');
      const result = await pool.query<ProviderConfigRow>(
        `UPDATE provider_configs
            SET display_name = COALESCE($4, display_name),
                config = COALESCE($5::jsonb, config),
                credential_ref = CASE WHEN $6 THEN $7 ELSE credential_ref END,
                enabled = COALESCE($8, enabled),
                probe_status = 'not_tested', probe_result = NULL, last_probe_at = NULL, probe_attempt_id = NULL,
                revision = revision + 1,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND revision = $3
          RETURNING *`,
        [
          id,
          workspaceId,
          expectedRevision,
          patch.displayName ?? null,
          patch.config !== undefined ? JSON.stringify(patch.config) : null,
          setCredential,
          setCredential ? (patch.credentialRef ?? null) : null,
          patch.enabled ?? null,
        ],
      );
      const row = result.rows[0];
      if (row) return { kind: 'ok', value: toProviderConfigRecord(row) };
      return resolveConflict(
        await pool.query<{ revision: number | string }>(
          `SELECT revision FROM provider_configs WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        ),
      );
    },

    async getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsRecord | null> {
      const result = await pool.query<WorkspaceSettingsRow>(
        `SELECT id, settings, revision FROM workspaces WHERE id = $1`,
        [workspaceId],
      );
      const row = result.rows[0];
      return row
        ? { workspaceId: row.id, settings: row.settings, revision: toInt(row.revision) }
        : null;
    },

    async updateWorkspaceSettings(
      workspaceId: string,
      expectedRevision: number,
      settings: Record<string, unknown>,
      updatedAt: Date,
    ): Promise<OptimisticResult<WorkspaceSettingsRecord>> {
      const result = await pool.query<WorkspaceSettingsRow>(
        `UPDATE workspaces
            SET settings = $3::jsonb, revision = revision + 1, updated_at = $4
          WHERE id = $1 AND revision = $2
          RETURNING id, settings, revision`,
        [workspaceId, expectedRevision, JSON.stringify(settings), updatedAt],
      );
      const row = result.rows[0];
      if (row) {
        return {
          kind: 'ok',
          value: { workspaceId: row.id, settings: row.settings, revision: toInt(row.revision) },
        };
      }
      return resolveConflict(
        await pool.query<{ revision: number | string }>(
          `SELECT revision FROM workspaces WHERE id = $1`,
          [workspaceId],
        ),
      );
    },
  };
}

function resolveConflict<T>(existing: {
  rows: { revision: number | string }[];
}): OptimisticResult<T> {
  const row = existing.rows[0];
  if (!row) return { kind: 'not_found' };
  return { kind: 'conflict', currentRevision: toInt(row.revision) };
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

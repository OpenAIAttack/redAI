import type { Executor } from '../pool.js';

export interface ProviderConfigRow {
  id: string;
  workspace_id: string;
  display_name: string;
  config: Record<string, unknown>;
  credential_ref: string | null;
  enabled: boolean;
  probe_status: string;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProviderConfigInput {
  workspaceId: string;
  displayName: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
}

/** Model provider configuration (workspace-scoped). Runs reference one via `provider_config_id`. */
export class ProviderConfigRepository {
  constructor(private readonly exec: Executor) {}

  async create(input: CreateProviderConfigInput): Promise<ProviderConfigRow> {
    const result = await this.exec.query<ProviderConfigRow>(
      `INSERT INTO provider_configs (workspace_id, display_name, config, credential_ref)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [
        input.workspaceId,
        input.displayName,
        JSON.stringify(input.config ?? {}),
        input.credentialRef ?? null,
      ],
    );
    return required(result.rows[0], 'provider_config insert returned no row');
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

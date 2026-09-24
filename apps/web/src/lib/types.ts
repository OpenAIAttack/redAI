/**
 * Client-side mirrors of the API's JSON response shapes. These follow the exact
 * field names the Fastify plugins emit (snake_case). They are the ONLY contract
 * the browser relies on; no secret material ever appears in any of them.
 */

export interface SessionProfile {
  owner_id: string;
  workspace_id: string;
  username: string;
  csrf_token: string;
  expires_at: string;
  setup_complete: boolean;
}

export type ApprovalMode = 'automatic' | 'always_ask' | 'ask_high_risk' | 'reject';
export type DataMode = 'local_only' | 'redacted_cloud' | 'cloud_full';
export type ProjectStatus = 'active' | 'archived' | 'deleting';

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  is_inbox: boolean;
  approval_mode: ApprovalMode;
  data_mode: DataMode;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface Chat {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  pinned: boolean;
  revision: number;
  message_seq: number;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  content: string;
  selected_for_context: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkerBinding {
  workspace_id: string;
  project_id: string;
  worker_id: string;
  zone: string | null;
  enabled: boolean;
  created_at: string;
}

export interface Artifact {
  id: string;
  project_id: string;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  classification: string;
  status: string;
  created_at: string;
}

export interface WorkspaceSettings {
  workspace_id: string;
  settings: Record<string, unknown>;
  revision: number;
}

export interface ProviderConfig {
  id: string;
  workspace_id: string;
  display_name: string;
  config: Record<string, unknown>;
  credential_ref: string | null;
  credential: {
    ref: string;
    name: string;
    kind: string;
    version: number;
    masked: string;
    revoked: boolean;
  } | null;
  revision: number;
  enabled: boolean;
  probe_status: string;
  last_probe_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecretMetadata {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  kind: string;
  version: number;
  allowed_origins: string[];
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListResponse<T> {
  items: T[];
  next_cursor?: string | null;
}

/** The typed error envelope every plugin returns on failure. */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

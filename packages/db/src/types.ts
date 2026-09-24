/**
 * Row and enum types for the tables the T02 repositories touch. Enums mirror
 * `SPEC_LOCK.json` and `db/001_reference_schema.sql` CHECK constraints exactly.
 * These are DB-shape types local to `@redai/db`; the pure `@redai/domain` package
 * does not depend on them.
 */

// --- enums (must match SPEC_LOCK.json / reference DDL) ---

export type ApprovalMode = 'automatic' | 'always_ask' | 'ask_high_risk' | 'reject';

export type ProjectStatus = 'active' | 'archived' | 'deleting' | 'deleted';

export type DataMode = 'local_only' | 'redacted_cloud' | 'cloud_full';

export type RunMode = 'ask' | 'agent';

export type RunKind = 'normal' | 'retest';

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_worker'
  | 'paused'
  | 'cancel_requested'
  | 'cancellation_pending'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';

export type RunOutcome = 'none' | 'complete' | 'partial' | 'blocked';

/** Run states that count as "active" for the one-active-run-per-chat invariant (INV-002). */
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_worker',
  'paused',
  'cancel_requested',
  'cancellation_pending',
  'needs_attention',
];

export type ArtifactStatus = 'pending' | 'ready' | 'quarantined' | 'deleting' | 'deleted';

export type ArtifactClassification = 'public' | 'internal' | 'sensitive' | 'restricted';

export type VerificationStatus =
  | 'candidate'
  | 'needs_review'
  | 'verified'
  | 'rejected'
  | 'inconclusive';

export type RemediationStatus = 'open' | 'fixed' | 'accepted_risk';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// --- row types ---

export interface WorkspaceRow {
  id: string;
  singleton: boolean;
  name: string;
  installation_id: string;
  settings: Record<string, unknown>;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface OwnerRow {
  id: string;
  workspace_id: string;
  username: string;
  password_hash: string;
  recovery_code_hash: Buffer;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  is_inbox: boolean;
  approval_mode: ApprovalMode;
  data_mode: DataMode;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface ChatRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  pinned: boolean;
  revision: string;
  message_seq: string;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  workspace_id: string;
  project_id: string;
  chat_id: string;
  mode: RunMode;
  kind: RunKind;
  state: RunState;
  outcome: RunOutcome;
  provider_config_id: string;
  selected_worker_id: string | null;
  scope_version_id: string | null;
  grant_id: string | null;
  resumes_run_id: string | null;
  config_snapshot: Record<string, unknown>;
  budget_limit_micro_usd: string;
  expires_at: Date;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface EventRow {
  workspace_id: string;
  event_id: string;
  project_id: string | null;
  run_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

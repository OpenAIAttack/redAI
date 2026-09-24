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

// --- runs / chat messages ---------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'interrupted';

/** A durable chat message (matches the runs plugin `messageDto`). */
export interface Message {
  id: string;
  chat_id: string;
  run_id: string | null;
  seq: number;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  artifact_ids: string[];
  created_at: string;
}

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

/** Run status (matches the runs plugin `runStatusDto`). */
export interface RunStatus {
  id: string;
  workspace_id: string;
  project_id: string;
  chat_id: string;
  mode: string;
  kind: string;
  state: RunState;
  outcome: string | null;
  provider_config_id: string;
  step_count: number;
  budget_limit_micro_usd: string;
  stop_reason: string | null;
  expires_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** Response of `POST /projects/:p/chats/:c/runs`. */
export interface CreateRunResponse {
  run: RunStatus;
  message: Message;
}

// --- realtime event envelopes (contracts/schemas/event.schema.json) ---------

/** Fields every event envelope carries. `event_id` is a decimal-string counter. */
export interface EventEnvelopeBase {
  schema_version: string;
  event_id: string;
  workspace_id: string;
  project_id: string | null;
  run_id: string | null;
  type: string;
  created_at: string;
}

export interface RunCreatedEvent extends EventEnvelopeBase {
  type: 'run.created';
  data: { run_id: string; chat_id: string };
}

export interface RunStateChangedEvent extends EventEnvelopeBase {
  type: 'run.state_changed';
  data: { from: RunState; to: RunState; reason_code: string | null };
}

export interface MessageDeltaEvent extends EventEnvelopeBase {
  type: 'message.delta';
  data: {
    message_id: string;
    generation_id: string;
    delta_seq: string;
    text: string;
    provisional: true;
  };
}

export interface MessageCommittedEvent extends EventEnvelopeBase {
  type: 'message.committed';
  data: { message_id: string; sha256: string; status: 'completed' | 'interrupted' };
}

export interface BudgetUpdatedEvent extends EventEnvelopeBase {
  type: 'budget.updated';
  data: {
    observed_micro_usd: string;
    reserved_micro_usd: string;
    limit_micro_usd: string;
  };
}

export interface PlanUpdatedEvent extends EventEnvelopeBase {
  type: 'plan.updated';
  data: { plan_revision: number; step_count: number };
}

/**
 * The envelope types the web client models. Other real types (tool.state_changed,
 * approval.*, worker.*, etc.) still arrive over the wire and are handled honestly
 * by the reducer's default branch (added to the activity log, never faked); they
 * are simply not narrowed here. Keeping this union closed lets the reducer switch
 * discriminate cleanly on `type`.
 */
export type EventEnvelope =
  | RunCreatedEvent
  | RunStateChangedEvent
  | MessageDeltaEvent
  | MessageCommittedEvent
  | BudgetUpdatedEvent
  | PlanUpdatedEvent;

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

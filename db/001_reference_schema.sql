-- redAI Personal v1 reference DDL, spec 1.0.0-draft.1, 2026-09-24.
-- PostgreSQL 18 target. Run in a fresh test database before using as a migration.
-- This file is a design contract; syntax validation is not an integration test.
BEGIN;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true CHECK (singleton),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  installation_id uuid NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (singleton)
);

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  recovery_code_hash bytea NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  csrf_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (owner_id, workspace_id) REFERENCES owners(id, workspace_id),
  CHECK (expires_at <= absolute_expires_at)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleting','deleted')),
  is_inbox boolean NOT NULL DEFAULT false,
  approval_mode text NOT NULL DEFAULT 'automatic' CHECK (approval_mode IN ('automatic','always_ask','ask_high_risk','reject')),
  data_mode text NOT NULL DEFAULT 'redacted_cloud' CHECK (data_mode IN ('local_only','redacted_cloud','cloud_full')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX one_inbox ON projects(workspace_id) WHERE is_inbox;

CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model_api_key','target_credential')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  key_id text NOT NULL,
  aad_sha256 text NOT NULL CHECK (aad_sha256 ~ '^[a-f0-9]{64}$'),
  allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  CHECK ((kind = 'target_credential' AND project_id IS NOT NULL) OR kind = 'model_api_key')
);

CREATE TABLE provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  display_name text NOT NULL,
  config jsonb NOT NULL,
  credential_ref uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT true,
  probe_status text NOT NULL DEFAULT 'not_tested',
  last_probe_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (credential_ref, workspace_id) REFERENCES secrets(id, workspace_id)
);

CREATE TABLE dns_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  root_ascii text NOT NULL,
  challenge_hash bytea NOT NULL UNIQUE,
  record_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','revoked')),
  verified_at timestamptz,
  observed_txt_sha256 text,
  resolver_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id)
);

CREATE TABLE scope_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (project_id, version),
  FOREIGN KEY (created_by, workspace_id) REFERENCES owners(id, workspace_id)
);

CREATE TABLE authorization_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scope_version_id uuid NOT NULL,
  dns_proof_id uuid,
  created_by uuid NOT NULL,
  authorization_basis text NOT NULL CHECK (authorization_basis IN ('owner_attestation','written_authorization','lab_attestation')),
  attestation text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  policy_epoch bigint NOT NULL DEFAULT 1 CHECK (policy_epoch > 0),
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (scope_version_id, project_id, workspace_id) REFERENCES scope_versions(id, project_id, workspace_id),
  FOREIGN KEY (dns_proof_id, project_id, workspace_id) REFERENCES dns_proofs(id, project_id, workspace_id),
  FOREIGN KEY (created_by, workspace_id) REFERENCES owners(id, workspace_id),
  UNIQUE (id, scope_version_id, project_id, workspace_id)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  canonical_identifier text NOT NULL,
  discovery_source text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (project_id, kind, canonical_identifier)
);

CREATE TABLE workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  display_name text NOT NULL,
  zone text NOT NULL,
  capacity integer NOT NULL DEFAULT 2 CHECK (capacity BETWEEN 1 AND 8),
  state text NOT NULL DEFAULT 'offline' CHECK (state IN ('online','offline','draining','revoked','unhealthy')),
  agent_version text NOT NULL,
  manifest_sha256 text NOT NULL,
  session_id uuid,
  session_generation bigint NOT NULL DEFAULT 0 CHECK (session_generation >= 0),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (id, zone, workspace_id)
);

CREATE TABLE worker_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (worker_id, workspace_id) REFERENCES workers(id, workspace_id)
);

CREATE TABLE enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  token_hash bytea NOT NULL UNIQUE,
  worker_defaults jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_worker_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consumed_worker_id, workspace_id) REFERENCES workers(id, workspace_id)
);

CREATE TABLE project_workers (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, worker_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (worker_id, zone, workspace_id) REFERENCES workers(id, zone, workspace_id)
);

CREATE TABLE chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL DEFAULT '',
  pinned boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  message_seq bigint NOT NULL DEFAULT 0 CHECK (message_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('ask','agent')),
  kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','retest')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting_approval','waiting_worker','paused','cancel_requested','cancellation_pending','needs_attention','completed','failed','canceled','expired')),
  outcome text NOT NULL DEFAULT 'none' CHECK (outcome IN ('none','complete','partial','blocked')),
  provider_config_id uuid NOT NULL,
  selected_worker_id uuid,
  scope_version_id uuid,
  grant_id uuid,
  resumes_run_id uuid,
  config_snapshot jsonb NOT NULL,
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan_revision bigint NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  runtime_owner text,
  runtime_fence bigint NOT NULL DEFAULT 0,
  runtime_lease_until timestamptz,
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  budget_limit_micro_usd bigint NOT NULL CHECK (budget_limit_micro_usd >= 0),
  active_elapsed_ms bigint NOT NULL DEFAULT 0 CHECK (active_elapsed_ms >= 0),
  expires_at timestamptz NOT NULL,
  cancel_requested_at timestamptz,
  pause_requested_at timestamptz,
  stop_reason text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (chat_id, project_id, workspace_id) REFERENCES chats(id, project_id, workspace_id),
  FOREIGN KEY (provider_config_id, workspace_id) REFERENCES provider_configs(id, workspace_id),
  FOREIGN KEY (selected_worker_id, workspace_id) REFERENCES workers(id, workspace_id),
  FOREIGN KEY (grant_id, scope_version_id, project_id, workspace_id) REFERENCES authorization_grants(id, scope_version_id, project_id, workspace_id),
  CHECK ((grant_id IS NULL) = (scope_version_id IS NULL)),
  FOREIGN KEY (resumes_run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id)
);

CREATE UNIQUE INDEX one_active_run_per_chat ON runs(chat_id) WHERE state IN ('queued','running','waiting_approval','waiting_worker','paused','cancel_requested','cancellation_pending','needs_attention');

CREATE INDEX runs_claimable ON runs(state, runtime_lease_until, created_at) WHERE state IN ('queued','running','waiting_worker');

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  run_id uuid,
  client_message_id uuid,
  seq bigint NOT NULL CHECK (seq > 0),
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  text_content text NOT NULL DEFAULT '',
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','streaming','completed','interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (chat_id, project_id, workspace_id) REFERENCES chats(id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  UNIQUE (chat_id, seq),
  UNIQUE (chat_id, client_message_id)
);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  selected_for_context boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  kind text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','quarantined','deleting','deleted')),
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','sensitive','restricted')),
  source_run_id uuid,
  source_attempt_id uuid,
  original_artifact_id uuid,
  transform_metadata jsonb,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (source_run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (original_artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id)
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  text_redacted text NOT NULL,
  start_offset bigint NOT NULL CHECK (start_offset >= 0),
  end_offset bigint NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', text_redacted)) STORED,
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id),
  UNIQUE (artifact_id, chunk_index),
  CHECK (end_offset >= start_offset)
);

CREATE INDEX document_chunks_fts ON document_chunks USING gin(search_vector);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  parent_agent_session_id uuid,
  role text NOT NULL CHECK (role IN ('coordinator','child')),
  depth integer NOT NULL CHECK (depth BETWEEN 0 AND 1),
  objective text NOT NULL,
  allowed_tools jsonb NOT NULL,
  state text NOT NULL,
  max_steps integer NOT NULL CHECK (max_steps BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  UNIQUE (id, run_id, project_id, workspace_id),
  FOREIGN KEY (parent_agent_session_id, run_id, project_id, workspace_id) REFERENCES agent_sessions(id, run_id, project_id, workspace_id),
  CHECK ((role = 'coordinator' AND depth = 0 AND parent_agent_session_id IS NULL) OR (role = 'child' AND depth = 1 AND parent_agent_session_id IS NOT NULL))
);

CREATE UNIQUE INDEX one_coordinator ON agent_sessions(run_id) WHERE role = 'coordinator';

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_session_id uuid NOT NULL,
  step_no integer NOT NULL CHECK (step_no > 0),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','calling_model','model_committed','waiting_tools','completed','failed')),
  provider_request_id text,
  provider_attempt integer NOT NULL DEFAULT 1,
  context_manifest jsonb NOT NULL,
  response_json jsonb,
  response_artifact_id uuid,
  runtime_fence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (agent_session_id, run_id, project_id, workspace_id) REFERENCES agent_sessions(id, run_id, project_id, workspace_id),
  FOREIGN KEY (response_artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id),
  UNIQUE (agent_session_id, step_no),
  UNIQUE (id, run_id, project_id, workspace_id)
);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_step_id uuid,
  provider_tool_index integer,
  actor_kind text NOT NULL CHECK (actor_kind IN ('model','owner')),
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  canonical_input text NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  effect_class text NOT NULL CHECK (effect_class IN ('pure','sandbox_write','external_read','external_write','destructive','unknown')),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','blocked','waiting_approval','queued','executing','succeeded','failed','canceled','unknown')),
  policy_decision jsonb NOT NULL,
  fingerprint text NOT NULL,
  current_attempt_id uuid,
  next_fence bigint NOT NULL DEFAULT 0 CHECK (next_fence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (agent_step_id, run_id, project_id, workspace_id) REFERENCES agent_steps(id, run_id, project_id, workspace_id),
  UNIQUE (agent_step_id, provider_tool_index),
  UNIQUE (id, run_id, project_id, workspace_id),
  CHECK ((actor_kind = 'model' AND agent_step_id IS NOT NULL AND provider_tool_index IS NOT NULL) OR actor_kind = 'owner')
);

CREATE TABLE task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 10),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  worker_id uuid,
  worker_session_id uuid,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','started','uploading','succeeded','failed','cancel_requested','canceled','lost','unknown')),
  lease_until timestamptz,
  lease_claims jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  result_json jsonb,
  result_sha256 text,
  observed_quiescent boolean NOT NULL DEFAULT false,
  effect_observation text CHECK (effect_observation IN ('not_started','completed','unknown')),
  journal_seq bigint NOT NULL DEFAULT 0,
  output_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (tool_call_id, run_id, project_id, workspace_id) REFERENCES tool_calls(id, run_id, project_id, workspace_id),
  FOREIGN KEY (worker_id, workspace_id) REFERENCES workers(id, workspace_id),
  UNIQUE (tool_call_id, attempt_no),
  UNIQUE (tool_call_id, fencing_token),
  UNIQUE (id, tool_call_id),
  UNIQUE (id, run_id, project_id, workspace_id),
  CHECK ((worker_id IS NULL) = (worker_session_id IS NULL))
);

CREATE UNIQUE INDEX one_unsettled_attempt_per_call ON task_attempts(tool_call_id) WHERE state IN ('queued','leased','started','uploading','cancel_requested','lost','unknown');

CREATE INDEX task_queue ON task_attempts(created_at) WHERE state = 'queued';
CREATE INDEX worker_active_attempts ON task_attempts(worker_id, state, lease_until);

ALTER TABLE tool_calls ADD CONSTRAINT call_current_attempt_fk FOREIGN KEY (current_attempt_id, id) REFERENCES task_attempts(id, tool_call_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD CONSTRAINT artifact_source_attempt_fk FOREIGN KEY (source_attempt_id, source_run_id, project_id, workspace_id) REFERENCES task_attempts(id, run_id, project_id, workspace_id);
ALTER TABLE artifacts ADD CONSTRAINT artifact_attempt_requires_run CHECK (source_attempt_id IS NULL OR source_run_id IS NOT NULL);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired','stale')),
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (tool_call_id, run_id, project_id, workspace_id) REFERENCES tool_calls(id, run_id, project_id, workspace_id),
  FOREIGN KEY (decided_by, workspace_id) REFERENCES owners(id, workspace_id)
);

CREATE UNIQUE INDEX one_pending_approval ON approvals(tool_call_id) WHERE state = 'pending';

CREATE TABLE artifact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  relationship text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id),
  UNIQUE (artifact_id, source_kind, source_id, relationship)
);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  dedup_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id)
);

CREATE TABLE finding_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  content jsonb NOT NULL,
  verification_status text NOT NULL DEFAULT 'candidate' CHECK (verification_status IN ('candidate','needs_review','verified','rejected','inconclusive')),
  remediation_status text NOT NULL DEFAULT 'open' CHECK (remediation_status IN ('open','fixed','accepted_risk')),
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  source_run_id uuid,
  owner_confirmed boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (finding_id, project_id, workspace_id) REFERENCES findings(id, project_id, workspace_id),
  FOREIGN KEY (source_run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (created_by, workspace_id) REFERENCES owners(id, workspace_id),
  UNIQUE (finding_id, version),
  UNIQUE (id, finding_id, project_id, workspace_id)
);

ALTER TABLE findings ADD CONSTRAINT finding_current_version_fk FOREIGN KEY (id, current_version) REFERENCES finding_versions(finding_id, version) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE finding_evidence (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  finding_version_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  relation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (finding_version_id, artifact_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (finding_version_id, project_id, workspace_id) REFERENCES finding_versions(id, project_id, workspace_id),
  FOREIGN KEY (artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id)
);

CREATE TABLE retests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  finding_version_id uuid NOT NULL,
  run_id uuid NOT NULL,
  result text CHECK (result IN ('observed_fixed','still_present','inconclusive')),
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (finding_version_id, project_id, workspace_id) REFERENCES finding_versions(id, project_id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  UNIQUE (run_id)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','rendering','ready','failed')),
  output_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  template_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  UNIQUE (id, project_id, workspace_id)
);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_step_id uuid,
  provider_attempt integer NOT NULL,
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','reconciled','released','unknown')),
  pricing_snapshot jsonb NOT NULL,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  FOREIGN KEY (agent_step_id, project_id, workspace_id) REFERENCES agent_steps(id, project_id, workspace_id),
  UNIQUE (run_id, request_fingerprint),
  UNIQUE (id, run_id, project_id, workspace_id)
);

CREATE TABLE usage_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  provider_request_id text,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  observed_micro_usd bigint CHECK (observed_micro_usd >= 0),
  basis text NOT NULL CHECK (basis IN ('provider','estimated','unknown','local_zero_model_cost')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id),
  UNIQUE (reservation_id),
  FOREIGN KEY (reservation_id, run_id, project_id, workspace_id) REFERENCES budget_reservations(id, run_id, project_id, workspace_id)
);

CREATE TABLE event_counters (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  next_event_id bigint NOT NULL DEFAULT 1 CHECK (next_event_id > 0)
);

CREATE TABLE events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  event_id bigint NOT NULL CHECK (event_id > 0),
  project_id uuid,
  run_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (run_id, project_id, workspace_id) REFERENCES runs(id, project_id, workspace_id)
);

ALTER TABLE events ADD CONSTRAINT event_run_requires_project CHECK (run_id IS NULL OR project_id IS NOT NULL);
CREATE INDEX events_project_cursor ON events(workspace_id, project_id, event_id);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_key text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  idempotency_key uuid NOT NULL,
  body_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  response_status integer,
  response_json jsonb,
  response_ciphertext bytea,
  response_nonce bytea,
  key_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, actor_key, method, route, idempotency_key),
  CHECK (response_json IS NULL OR response_ciphertext IS NULL)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  actor_kind text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  safe_metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id)
);

CREATE TABLE maintenance_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid,
  kind text NOT NULL CHECK (kind IN ('backup','export','import','purge','diagnostics','artifact_reconcile')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','failed')),
  payload jsonb NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_owner text,
  lease_until timestamptz,
  artifact_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id),
  FOREIGN KEY (artifact_id, project_id, workspace_id) REFERENCES artifacts(id, project_id, workspace_id)
);


ALTER TABLE maintenance_jobs ADD CONSTRAINT job_artifact_requires_project CHECK (artifact_id IS NULL OR project_id IS NOT NULL);

-- Immutable versions can be deleted only through controlled purge; updates are prohibited.
CREATE FUNCTION redai_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable version: %', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scope_version_immutable BEFORE UPDATE ON scope_versions
  FOR EACH ROW EXECUTE FUNCTION redai_reject_version_update();
CREATE TRIGGER finding_version_immutable BEFORE UPDATE ON finding_versions
  FOR EACH ROW EXECUTE FUNCTION redai_reject_version_update();

CREATE FUNCTION redai_protect_artifact_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('ready', 'deleting', 'deleted') AND
     (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'immutable finalized artifact payload' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_payload_immutable BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION redai_protect_artifact_payload();

-- This allocates an event cursor under a row lock retained until COMMIT.
-- The caller MUST invoke it within the same transaction as the business mutation.
CREATE FUNCTION redai_append_event(p_workspace uuid, p_project uuid, p_run uuid,
  p_type text, p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE result_id bigint;
BEGIN
  INSERT INTO event_counters(workspace_id) VALUES (p_workspace) ON CONFLICT DO NOTHING;
  UPDATE event_counters SET next_event_id = next_event_id + 1
    WHERE workspace_id = p_workspace RETURNING next_event_id - 1 INTO result_id;
  INSERT INTO events(workspace_id, event_id, project_id, run_id, event_type, payload)
    VALUES (p_workspace, result_id, p_project, p_run, p_type, p_payload);
  PERFORM pg_notify('redai_events', p_workspace::text);
  RETURN result_id;
END;
$$;

-- Use least-privilege DB roles in deployment; application roles must not be superuser.
-- Not all invariants fit DDL: live grant checks, verified-evidence gate, budget totals,
-- parent depth/child count, cursor schemas, worker capacity and replay decisions are
-- mandatory transaction/domain integration tests. Do not claim DDL alone enforces them.
COMMIT;

-- T08: derived evidence, never owner-supplied capability flags.
ALTER TABLE provider_configs ADD COLUMN probe_result jsonb;
ALTER TABLE provider_configs ADD COLUMN probe_attempt_id uuid;
